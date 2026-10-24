-- sms-inbound-events.sql: durable claim state machine for Telnyx inbound
-- webhook events. The Ed25519 timestamp check rejects old replays but not
-- valid replays inside the window; this table makes every side effect
-- idempotent on the provider event id AND records how far processing got,
-- so crashes and partial failures resolve to one outcome.
--   processing - claimed, side effects not yet durable (stale >2min reclaimed)
--   db_done    - mutation verified durable; confirmation text persisted in
--                detail BEFORE any send attempt; redelivery retries send only
--                (a 4xx is the only outcome that proves non-acceptance)
--   sending    - provider attempt in flight; entered only via an atomic
--                conditional update; a stale row here resolves to uncertain
--   done       - all side effects completed (or send disabled by gate);
--                2xx means accepted (not delivered); provider id in detail
--   uncertain  - provider outcome unknown (no response, 5xx, timeout, crash
--                mid-send); never auto-resend; desk reconciles
-- Claims are never deleted. Service-role only: no policies = default deny.
create table if not exists public.inbound_events (
  event_id text primary key,                 -- Telnyx event record id
  event_type text not null default '',
  from_phone text,
  status text not null default 'processing',
  detail text not null default '',
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.inbound_events add column if not exists status text not null default 'processing';
alter table public.inbound_events add column if not exists detail text not null default '';
alter table public.inbound_events add column if not exists updated_at timestamptz not null default now();
alter table public.inbound_events enable row level security;
