alter table public.zernio_connections add column template_review jsonb not null default '{}';
-- Force one fresh provider check instead of displaying an old readiness flag.
update public.zernio_connections set health_checked_at=null;
