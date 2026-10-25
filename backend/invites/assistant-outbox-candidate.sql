-- ASSISTANT OUTBOX CANDIDATE (REVIEW ONLY - NO APPLY AUTHORIZED)
-- Durable reply queue for the assistant reply path (currently
-- "stub-no-durable-capture"). Same discipline as inbound_events: unique
-- event id, owner/version CAS, immutable canonical payload + idempotency key
-- persisted at intent time, no blind retries, 'uncertain' is desk-held.
-- No inbound message body is stored here or anywhere - body retention is an
-- owner decision (see reply-path-prep.md). Service-role only.
create table if not exists public.assistant_outbox (
  event_id text primary key references public.inbound_events(event_id),
  reply_kind text not null check (reply_kind in ('welcome','conversation','lead')),
  status text not null default 'queued'
    check (status in ('queued','intent','sending','done','uncertain','failed','held')),
  detail text not null default '',
  owner text,
  version int not null default 1,
  idem_key text,
  payload jsonb,                -- canonical send payload once at intent, immutable
  first_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.assistant_outbox enable row level security;
-- Service-role only: no policies = default deny for anon/authenticated.
-- Explicit ACL revokes as belt-and-braces (RLS is the real boundary; these
-- keep default table privileges from ever leaking reads):
revoke all on public.assistant_outbox from public, anon, authenticated;
grant select, insert, update on public.assistant_outbox to service_role;
-- Apply safety: additive table only; no data change; no handler change
-- until the enqueue seam is reviewed. Idempotent (if not exists).
