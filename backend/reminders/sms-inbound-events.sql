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
--   uncertain  - provider outcome unknown (no response, 5xx, timeout, 409
--                idempotency conflict); never auto-resend; desk reconciles
--   failed     - provider permanently rejected (400/401/403/404/422);
--                terminal, never retried
-- 429 is the only retryable outcome (provably not accepted). All transitions
-- are owner+version compare-and-swap; the Telnyx Idempotency-Key is stored
-- before the first send attempt so any retry is a safe provider-side replay.
-- Claims are never deleted. Service-role only: no policies = default deny.
create table if not exists public.inbound_events (
  event_id text primary key,                 -- Telnyx event record id
  event_type text not null default '',
  from_phone text,
  status text not null default 'processing',
  detail text not null default '',
  owner text,                              -- per-attempt CAS owner id
  version int not null default 1,          -- CAS version for adoption races
  idem_key text,                           -- Telnyx Idempotency-Key, persisted with send intent
  payload jsonb,                           -- canonical send payload, immutable (key+payload never drift)
  first_attempt_at timestamptz,            -- immutable; 23h conservative replay-window bound
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.inbound_events add column if not exists status text not null default 'processing';
alter table public.inbound_events add column if not exists detail text not null default '';
alter table public.inbound_events add column if not exists updated_at timestamptz not null default now();
alter table public.inbound_events add column if not exists owner text;
alter table public.inbound_events add column if not exists version int not null default 1;
alter table public.inbound_events add column if not exists idem_key text;
alter table public.inbound_events add column if not exists payload jsonb;
alter table public.inbound_events add column if not exists first_attempt_at timestamptz;
alter table public.inbound_events enable row level security;
