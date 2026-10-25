-- INBOUND SWEEPER CANDIDATE v3 (REVIEW ONLY - NO APPLY AUTHORIZED)
-- Reconciliation half of the sweeper gap: finds claims left in
-- processing/sending past OUR recovery/lease threshold and moves them to
-- 'uncertain' for desk triage.
--
-- WHAT THE THRESHOLD IS: our own recovery/lease choice - how long a claim
-- may sit untouched before triage. It is NOT a measured provider
-- elapsed-retry policy: the messaging doc's "up to 3 attempts per URL" is
-- an attempt COUNT and says nothing about elapsed TIME per attempt, so no
-- elapsed provider budget is claimed anywhere here.
--
-- WHAT THE SWEEP CAN AND CANNOT DO (stage-qualified, not blanket "safe"):
--   Stage A (sweep lands while the row is 'processing', before the worker's
--     send-turn CAS): the worker's next CAS fails on status mismatch, it
--     backs off, NO provider call is ever dispatched. The confirmation is
--     SUPPRESSED (never sent) - a lost confirmation, which is exactly what
--     the 'uncertain' desk item exists to catch.
--   Stage B (sweep lands after the send-turn CAS, before dispatch) and
--   Stage C (after dispatch, before the outcome write): the provider call
--     IS (or is about to be) on the wire - irreversible. The worker's
--     outcome-write CAS then fails and the row stays 'uncertain': the desk
--     verifies delivery by the persisted idempotency key.
--   Never a duplicate: single-owner CAS + persisted idempotency key +
--   no-resend-from-'uncertain' are the verified mechanisms (handler tests);
--   this is not an unqualified network-delivery guarantee. The sweep never
--   touches durable suppression (sms_opt_outs is written only by the atomic
--   claim RPC). The sweep is NOT effect-free: it can suppress a
--   confirmation (A) or leave a sent confirmation's outcome unrecorded
--   (B/C); both land on desk reconciliation by design.
create or replace function public.inbound_sweep_stale(p_stale_before timestamptz default now() - interval '15 minutes')
returns table(event_id text, old_status text, new_status text)
language plpgsql security definer set search_path='public' as $$
begin
  -- bounded: refuse to sweep anything touched in the last minute - a sweep
  -- racing an active worker must lose by a wide margin
  if p_stale_before > now() - interval '1 minute' then
    raise exception 'stale threshold too recent: %', p_stale_before;
  end if;
  return query
    with old as (
      select e.event_id, e.status
        from public.inbound_events e
       where e.status in ('processing','sending')
         and e.updated_at < p_stale_before
    )
    update public.inbound_events t
       set status = 'uncertain',
           detail = t.detail || ' [swept: exceeded our recovery/lease threshold; desk reconcile per stage A/B/C]',
           updated_at = now()
      from old
     where t.event_id = old.event_id
       and t.status = old.status   -- CAS: transition only if nothing moved the row since the read
    returning old.event_id, old.status, 'uncertain'::text;
end $$;
revoke all on function public.inbound_sweep_stale(timestamptz) from public, anon, authenticated;
grant execute on function public.inbound_sweep_stale(timestamptz) to service_role;
-- Apply safety: additive function only, no data change on apply, no schedule
-- created. A scheduler binding is a separate deploy decision, not part of
-- this candidate.
