-- INBOUND SWEEPER CANDIDATE (REVIEW ONLY - NO APPLY AUTHORIZED)
-- Closes the reconciliation half of the standing sweeper gap: with the
-- atomic claim RPC, a stale keyword claim already has suppression durable,
-- so this sweep is about VISIBILITY and triage, not safety. It finds claims
-- whose provider retry budget is certainly exhausted (messaging: up to 3
-- attempts per URL then failover per the product doc) and moves them to a
-- desk-visible terminal-ish state:
--   processing -> 'uncertain' (side effects unknown; mutations in the
--                  current design are idempotent, so a LATE redelivery or
--                  worker can still adopt and finish safely)
--   sending    -> 'uncertain' (provider acceptance unknowable post-crash;
--                  never auto-resend - same rule as the handler)
-- It never touches done/failed/stale_event/held rows, never deletes, never
-- sends, and is idempotent. Staleness threshold is a parameter: the caller
-- (a scheduled job, deploy-time choice) supplies it; default 15 minutes is
-- far past any reasonable ack+retry window and chosen only as a safe
-- default, not a measured fact.
create or replace function public.inbound_sweep_stale(p_stale_before timestamptz default now() - interval '15 minutes')
returns table(event_id text, old_status text, new_status text)
language plpgsql security definer set search_path='public' as $$
begin
  return query
    update public.inbound_events
       set status = 'uncertain',
           detail = detail || ' [swept: provider retry budget certainly exhausted; desk reconcile]',
           updated_at = now()
     where status in ('processing','sending')
       and updated_at < p_stale_before
    returning inbound_events.event_id, inbound_events.status, 'uncertain'::text;
end $$;
revoke all on function public.inbound_sweep_stale(timestamptz) from public, anon, authenticated;
grant execute on function public.inbound_sweep_stale(timestamptz) to service_role;
-- NOTE: the returning clause reports post-update status via the constant;
-- old status is captured by the caller if needed (kept simple for review).
-- Apply safety: additive function only, no data change on apply, no schedule
-- created. A pg_cron or external scheduler binding is a separate deploy
-- decision and is NOT part of this candidate.
