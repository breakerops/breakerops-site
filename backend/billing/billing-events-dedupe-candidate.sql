-- BILLING EVENTS DEDUPE CANDIDATE (REVIEW ONLY - NO APPLY AUTHORIZED)
-- Makes the webhook's provider+provider_event_id idempotency race-safe:
-- the dedupe pre-check alone lets two concurrent deliveries of the same
-- event both insert. The unique index is the actual guard; the webhook
-- then treats a unique violation as a duplicate (200) instead of an error.
-- NULL event ids (placeholder posts without id) stay allowed: Postgres
-- unique indexes treat NULLs as distinct.
-- Idempotent (if not exists). No data change; no apply authorized.
begin;
create unique index if not exists billing_events_provider_event_uidx
  on public.billing_events (provider, provider_event_id);
commit;

-- APPLY SAFETY RUNBOOK (added per review, no auto-anything):
-- PREFLIGHT (read-only, run first, STOP on any nonzero):
--   select provider, provider_event_id, count(*)
--     from billing_events
--    where provider_event_id is not null
--    group by 1,2 having count(*) > 1;
--   select count(*) from billing_events where provider_event_id is null;
-- If the first query returns rows, STOP: existing duplicates must be
-- reviewed and resolved by hand; this candidate does not delete, merge or
-- modify any row. The unique index build will fail on duplicates, which is
-- the intended fail-closed behavior. Null provider_event_id rows are fine
-- (the index treats nulls as distinct) but are counted for awareness.
-- APPLY: run this candidate's transactional block alone (plain CREATE INDEX
-- inside begin/commit - NOT CONCURRENTLY, which cannot run in a transaction).
-- Acceptable only while the ledger is small; if billing_events has grown
-- large before apply, STOP and ask for a CONCURRENTLY variant run outside a
-- transaction instead. Then re-run the preflight and verify the index exists:
--   select indexname from pg_indexes where tablename='billing_events';
-- No assumption is made that production is empty; no deletion is ever part
-- of this candidate.
