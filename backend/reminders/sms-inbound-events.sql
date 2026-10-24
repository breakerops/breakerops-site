-- sms-inbound-events.sql: persistent dedupe for Telnyx inbound webhook events.
-- The Ed25519 timestamp check rejects old replays but not valid replays inside
-- the window; this table makes every side effect idempotent on the provider
-- event id. telnyx-inbound inserts before acting; a conflict means the event
-- was already processed.
create table if not exists public.inbound_events (
  event_id text primary key,                 -- Telnyx event record id
  event_type text not null default '',
  from_phone text,
  received_at timestamptz not null default now()
);
alter table public.inbound_events enable row level security;
-- Service-role only: no policies = default deny for anon/authenticated.
