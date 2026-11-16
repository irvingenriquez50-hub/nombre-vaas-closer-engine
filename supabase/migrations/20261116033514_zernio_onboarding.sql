-- New integration starts paused. Existing 360dialog credentials/history are preserved.
create table public.closer_settings (
  id boolean primary key default true check (id),
  sends_enabled boolean not null default false
);
insert into public.closer_settings(id) values(true);
create table public.zernio_connections (
  user_id uuid primary key references public.users(id) on delete cascade,
  profile_id text not null unique,
  account_id text unique,
  phone_number text,
  connected boolean not null default false,
  bot_enabled boolean not null default false,
  health_checked_at timestamptz,
  templates_ready boolean not null default false,
  opening_template text not null default 'vaas_opening_message',
  followup_template text not null default 'vaas_followup_message',
  template_language text not null default 'en',
  last_error text,
  updated_at timestamptz not null default now()
);
create unique index zernio_unique_phone on public.zernio_connections(phone_number) where phone_number is not null;
create table public.zernio_onboarding (
  state_hash text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  actor_id uuid not null,
  profile_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create table public.zernio_events (
  id text primary key,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  lease_until timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index zernio_pending_events on public.zernio_events(received_at) where processed_at is null;
create table public.zernio_conversations (
  user_id uuid not null references public.users(id) on delete cascade,
  account_id text not null,
  conversation_id text not null,
  jid text not null,
  primary key (account_id, conversation_id),
  unique (user_id, account_id, jid)
);
create table public.zernio_outbound (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  account_id text not null,
  path text not null,
  body jsonb not null,
  state text not null default 'sending' check(state in ('sending','sent','unknown','rejected')),
  response jsonb,
  created_at timestamptz not null default now(),
  last_error text
);
-- These are server-owned tables: no client can activate itself or assign an account.
alter table public.closer_settings enable row level security;
alter table public.zernio_connections enable row level security;
alter table public.zernio_onboarding enable row level security;
alter table public.zernio_events enable row level security;
alter table public.zernio_conversations enable row level security;
alter table public.zernio_outbound enable row level security;
revoke all on public.closer_settings, public.zernio_connections, public.zernio_onboarding,
  public.zernio_events, public.zernio_conversations, public.zernio_outbound from anon, authenticated;
grant all on public.closer_settings, public.zernio_connections, public.zernio_onboarding,
  public.zernio_events, public.zernio_conversations, public.zernio_outbound to service_role;
-- The web panel no longer handles provider credentials.
revoke all on public.whatsapp_channels from anon, authenticated;

create function public.closer_append_message(p_user uuid, p_jid text, p_role text,
  p_content text, p_event text default null, p_at timestamptz default now())
returns public.leads language plpgsql security invoker set search_path = '' as $$
declare l public.leads;
begin
  select * into l from public.leads where user_id=p_user and jid=p_jid for update;
  if not found then return null; end if;
  if p_event is not null and exists(select 1 from jsonb_array_elements(l.conversation) m where m->>'eventId'=p_event) then return l; end if;
  update public.leads set conversation=conversation || jsonb_build_array(jsonb_build_object(
    'role',p_role,'content',p_content,'ts',extract(epoch from p_at)*1000,'eventId',p_event)),
    last_inbound_at=case when p_role='user' then greatest(last_inbound_at,p_at) else last_inbound_at end,
    updated_at=now()
    where id=l.id returning * into l;
  return l;
end $$;
revoke all on function public.closer_append_message(uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.closer_append_message(uuid,text,text,text,text,timestamptz) to service_role;

create function public.closer_claim_events() returns setof public.zernio_events
language sql security invoker set search_path = '' as $$
  update public.zernio_events set lease_until=now()+interval '2 minutes', attempts=attempts+1
  where id in (select id from public.zernio_events where processed_at is null
    and (lease_until is null or lease_until<now()) and attempts<12
    order by received_at for update skip locked limit 10) returning *;
$$;
revoke all on function public.closer_claim_events() from public,anon,authenticated;
grant execute on function public.closer_claim_events() to service_role;

create function public.closer_finish_onboarding(p_hash text, p_actor uuid, p_account text, p_phone text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare s public.zernio_onboarding;
begin
  select * into s from public.zernio_onboarding where state_hash=p_hash and actor_id=p_actor
    and consumed_at is null and expires_at>now() for update;
  if not found then raise exception 'La conexión expiró. Vuelve a conectar.'; end if;
  update public.zernio_connections set account_id=p_account, phone_number=p_phone,
    connected=false, bot_enabled=false, templates_ready=false, health_checked_at=null,
    updated_at=now() where user_id=s.user_id and profile_id=s.profile_id;
  if not found then raise exception 'Perfil de conexión inválido'; end if;
  update public.zernio_onboarding set consumed_at=now() where state_hash=p_hash;
  return s.user_id;
end $$;
revoke all on function public.closer_finish_onboarding(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.closer_finish_onboarding(text,uuid,text,text) to service_role;
