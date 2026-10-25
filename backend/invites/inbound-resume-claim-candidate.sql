-- RESUME-CLAIM CANDIDATE v1 (REVIEW ONLY - NO APPLY AUTHORIZED)
-- The durable half of AF-1 recovery: a scheduler-driven worker needs an
-- atomic way to adopt ONE parked db_done row for same-key in-window resume.
--
-- What this is: the adoption primitive ONLY. It does not send anything and
-- does not replace the handler's resume discipline (23h window against the
-- provider replay horizon, ORIGINAL idempotency key + payload, pre-send
-- contradiction re-check) - it hands exactly one eligible row to a worker
-- that then follows that discipline through the existing handler path.
--
-- What "eligible" means (persisted intent, not blind resend):
--   status = 'db_done'           - intent recorded, DB mutation verified durable
--   idem_key IS NOT NULL         - without the original key there is no safe
--                                  resume; such rows stay for the sweeper/desk
--   first_attempt_at within the resume window (default 23h, provider replay
--   horizon minus margin)        - outside it, resume is unsafe and the row
--                                  belongs to the sweeper's uncertain triage
--
-- Concurrency: FOR UPDATE SKIP LOCKED takes the row lock at select time; the
--   status re-check on the update is belt-and-braces over that lock, so
--   * two workers never adopt the same row (SKIP LOCKED),
--   * a sweeper that flipped the row to 'uncertain' before the select is
--     never adopted (eligibility), and one racing the select loses to the
--     status re-check (Stage A),
--   * adoption KEEPS the row at db_done (owner flipped, version bumped): the
--     worker's send-turn CAS (db_done -> sending) is the same transition the
--     webhook redelivery path uses, so worker and redelivery share one
--     discipline and race each other safely (version/status CAS; one wins),
--   * a worker crash after adoption leaves the row at db_done with the
--     worker's owner - the existing sweeper recovers it, unchanged semantics.
--
-- Returns the adopted row (idem_key + payload are the resume inputs), or no
-- row when nothing is eligible. No timestamp trust beyond OUR OWN
-- first_attempt_at (server clock, one domain); the provider occurred_at
-- anchor is untouched.

create or replace function public.inbound_claim_resume(
  p_worker text,
  p_window interval default interval '23 hours'
) returns setof public.inbound_events
language plpgsql security definer set search_path='public' as $$
declare
  v_id text;
begin
  if p_worker is null or length(trim(p_worker)) = 0 then
    raise exception 'worker id required';
  end if;
  if p_window is null or p_window <= interval '0' or p_window > interval '23 hours' then
    raise exception 'resume window must be in (0, 23h]';
  end if;

  select e.event_id into v_id
    from public.inbound_events e
   where e.status = 'db_done'
     and e.idem_key is not null
     and e.payload is not null        -- canonical payload required with the key
     and e.first_attempt_at is not null
     and e.first_attempt_at > now() - p_window
   order by e.first_attempt_at asc
   limit 1
   for update skip locked;

  if not found then return; end if;

  return query
    update public.inbound_events t
       set owner = p_worker,
           version = t.version + 1,
           detail = t.detail || ' [resume-adopted by ' || p_worker || ' for same-key in-window resume]',
           updated_at = now()
     where t.event_id = v_id
       and t.status = 'db_done'
    returning t.*;
end $$;
revoke all on function public.inbound_claim_resume(text, interval) from public, anon, authenticated;
grant execute on function public.inbound_claim_resume(text, interval) to service_role;
-- Apply safety: additive function only, no data change on apply.
