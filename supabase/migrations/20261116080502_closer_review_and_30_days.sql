-- Keep history and member decisions; only the discovery window becomes 30 days.
update public.closer_automation set lookback_days=30,last_sync_at=null,history_checked_at=null where lookback_days<>30;
alter table public.closer_automation alter column lookback_days set default 30;
alter table public.closer_automation drop constraint closer_automation_lookback_days_check;
alter table public.closer_automation add constraint closer_automation_lookback_days_check check(lookback_days=30);

create table public.closer_tracker_reviews (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id),
 lead_id uuid not null references public.leads(id), phone text not null, event_id text, evidence text,
 created_at timestamptz not null default now(), sent_at timestamptz,
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(), last_error text,
 unique(lead_id)
);
alter table public.closer_tracker_reviews enable row level security;
revoke all on public.closer_tracker_reviews from public,anon,authenticated;
grant all on public.closer_tracker_reviews to service_role;

create function public.closer_review_contact(p_user uuid,p_phone text,p_reason text,p_history text default null) returns void
language plpgsql security invoker set search_path=public as $$
begin
 insert into closer_contacts(user_id,phone,state,reason,history_source) values(p_user,p_phone,'review',p_reason,p_history)
 on conflict(user_id,phone) do update set state='review',reason=excluded.reason,
 history_source=coalesce(excluded.history_source,closer_contacts.history_source)
 where closer_contacts.state in ('queued','active','review');
 update leads set paused=true,last_error=p_reason,updated_at=now()
 where user_id=p_user and regexp_replace(phone,'[^0-9]','','g')=p_phone and status<>'cerrado'
 and not coalesce((negotiation->>'manualCollab')::boolean,false) and not coalesce((negotiation->>'optedOut')::boolean,false);
end $$;

create function public.closer_existing_collaboration(p_user uuid,p_jid text,p_evidence text,p_event text default null) returns void
language plpgsql security invoker set search_path=public as $$
declare l leads; normalized text;
begin
 select * into l from leads where user_id=p_user and jid=p_jid for update;
 if not found or l.status='cerrado' or coalesce((l.negotiation->>'optedOut')::boolean,false) then return; end if;
 normalized=regexp_replace(l.phone,'[^0-9]','','g');
 update leads set paused=true,status='dormant',updated_at=now(),last_error=null,
 negotiation=coalesce(negotiation,'{}')||jsonb_build_object('manualCollab',true,'existingCollaboration',true,'collaborationEvidence',left(p_evidence,2000)) where id=l.id;
 insert into closer_contacts(user_id,phone,state,reason,history_source)
 values(p_user,normalized,'collaborated','La marca indicó que ya tienen una colaboración. El bot dejó de responder.','whatsapp')
 on conflict(user_id,phone) do update set state='collaborated',reason=excluded.reason,history_source='whatsapp'
 where closer_contacts.state<>'blocked';
 insert into closer_tracker_reviews(user_id,lead_id,phone,event_id,evidence) values(p_user,l.id,normalized,p_event,left(p_evidence,2000))
 on conflict(lead_id) do nothing;
end $$;
revoke all on function public.closer_review_contact(uuid,text,text,text),public.closer_existing_collaboration(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.closer_review_contact(uuid,text,text,text),public.closer_existing_collaboration(uuid,text,text,text) to service_role;
