alter table public.leads add column if not exists outreach_cycle uuid not null default gen_random_uuid();
create table public.closer_automation (
 user_id uuid primary key references public.users(id),
 lookback_days integer not null default 60 check(lookback_days in (30,60)),
 consent_at timestamptz, consent_actor uuid, last_sync_at timestamptz, last_error text,
 history_checked_at timestamptz, history_account_id text,
 updated_at timestamptz not null default now()
);
create table public.closer_contacts (
 user_id uuid not null references public.users(id), phone text not null,
 product text not null default '', videos_text text not null default '', price_text text not null default '',
 source_id text, source_at timestamptz, first_seen_at timestamptz not null default now(),
 state text not null default 'queued' check(state in('queued','review','active','skipped','collaborated','blocked')),
 reason text, history_source text, reviewed_at timestamptz,
 primary key(user_id,phone), check(phone ~ '^[1-9][0-9]{7,14}$')
);
create index closer_contacts_queue on public.closer_contacts(user_id,state,source_at);
create table public.closer_outreach_clock(account_id text primary key,next_at timestamptz not null);
create table public.closer_leases(scope text primary key,owner uuid not null,expires_at timestamptz not null);
-- Different workers or message kinds cannot open concurrent unresolved sends for one lead.
create unique index closer_one_unresolved_send on public.zernio_outbound(lead_id) where state in('sending','unknown');

create function public.closer_claim_outreach(p_account text) returns boolean
language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 insert into closer_outreach_clock(account_id,next_at) values(p_account,clock_timestamp()+interval '60 seconds')
 on conflict(account_id) do update set next_at=clock_timestamp()+interval '60 seconds'
 where closer_outreach_clock.next_at<=clock_timestamp();
 get diagnostics affected=row_count;
 return affected=1;
end $$;

create function public.closer_claim_lease(p_scope text,p_owner uuid,p_seconds integer default 600) returns boolean
language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 insert into closer_leases values(p_scope,p_owner,clock_timestamp()+make_interval(secs=>least(greatest(p_seconds,30),600)))
 on conflict(scope) do update set owner=excluded.owner,expires_at=excluded.expires_at
 where closer_leases.expires_at<=clock_timestamp();
 get diagnostics affected=row_count; return affected=1;
end $$;

-- The decision and lead reset are one transaction. Histories and send receipts are never deleted.
create function public.closer_contact_decide(p_user uuid,p_phone text,p_action text) returns void
language plpgsql security definer set search_path=public as $$
declare item closer_contacts; l leads; target text;
begin
 select * into item from closer_contacts where user_id=p_user and phone=p_phone for update;
 if not found then raise exception 'Contact not found'; end if;
 select * into l from leads where user_id=p_user and regexp_replace(phone,'[^0-9]','','g')=p_phone order by added_at limit 1 for update;
 if p_action='send' then
  if item.state='blocked' or coalesce((l.negotiation->>'optedOut')::boolean,false) then raise exception 'Contact opted out'; end if;
  if exists(select 1 from zernio_outbound where lead_id=l.id and state in('sending','unknown')) then raise exception 'Uncertain send needs review'; end if;
  if not exists(select 1 from closer_automation where user_id=p_user and consent_at is not null) then raise exception 'Contact permission required'; end if;
  if exists(select 1 from closer_leases where scope='lead:'||p_user||':'||p_phone and expires_at>clock_timestamp()) then raise exception 'Conversation is being processed'; end if;
  if l.id is not null then
   update leads set status='nuevo',paused=false,last_error=null,followup_count=0,dormant_followup_sent=false,
    outreach_cycle=gen_random_uuid(),negotiation=jsonb_build_object('manualRestart',true,'contactSource',case when item.source_id is not null then 'VAAS community contact list' else null end),updated_at=now() where id=l.id;
  else
   insert into leads(user_id,phone,jid,status) values(p_user,p_phone,p_phone,'nuevo');
  end if;
  target='active';
 elsif p_action in ('collaborated','skipped') then
  target=p_action;
  update leads set paused=true,updated_at=now(),
   negotiation=coalesce(negotiation,'{}')||jsonb_build_object('manualCollab',p_action='collaborated') where id=l.id;
 else raise exception 'Invalid action'; end if;
 update closer_contacts set state=target,reviewed_at=now(),reason=case when target='active' then 'En cola por decisión tuya' else null end
 where user_id=p_user and phone=p_phone;
end $$;

alter table public.closer_automation enable row level security;
alter table public.closer_contacts enable row level security;
alter table public.closer_outreach_clock enable row level security;
alter table public.closer_leases enable row level security;
revoke all on public.closer_automation,public.closer_contacts,public.closer_outreach_clock,public.closer_leases from anon,authenticated;
grant all on public.closer_automation,public.closer_contacts,public.closer_outreach_clock,public.closer_leases to service_role;
revoke all on function public.closer_claim_outreach(text),public.closer_claim_lease(text,uuid,integer),public.closer_contact_decide(uuid,text,text) from public,anon,authenticated;
grant execute on function public.closer_claim_outreach(text),public.closer_claim_lease(text,uuid,integer),public.closer_contact_decide(uuid,text,text) to service_role;

-- Archiving in the UI preserves receipts and opt-outs; deleting a lead used to cascade its receipts.
revoke delete on public.leads from anon,authenticated;
insert into public.closer_contacts(user_id,phone,state,history_source)
select user_id,regexp_replace(phone,'[^0-9]','','g'),'blocked','closer' from public.leads
where negotiation->>'optedOut'='true' and regexp_replace(phone,'[^0-9]','','g') ~ '^[1-9][0-9]{7,14}$'
on conflict(user_id,phone) do update set state='blocked';

create function public.closer_preserve_contact_decision() returns trigger
language plpgsql security definer set search_path=public as $$
declare normalized text; disposition text;
begin
 normalized=regexp_replace(new.phone,'[^0-9]','','g');
 if normalized !~ '^[1-9][0-9]{7,14}$' then return new; end if;
 if new.negotiation->>'optedOut'='true' then disposition='blocked';
 elsif new.negotiation->>'manualCollab'='true' or new.status='cerrado' then disposition='collaborated';
 else return new; end if;
 insert into closer_contacts(user_id,phone,state,history_source) values(new.user_id,normalized,disposition,'closer')
 on conflict(user_id,phone) do update set state=case when closer_contacts.state='blocked' then 'blocked' else excluded.state end;
 return new;
end $$;
create trigger closer_preserve_contact_decision after insert or update of negotiation,status on public.leads
for each row execute function public.closer_preserve_contact_decision();
revoke all on function public.closer_preserve_contact_decision() from public,anon,authenticated;
