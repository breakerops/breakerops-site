-- DESK RECONCILIATION CANDIDATE v2 (REVIEW ONLY - NO APPLY AUTHORIZED)
-- The ONLY resolution path for held/uncertain claims and the ONLY
-- horizon-clear. Service-role only: the desk is Matt operating with
-- VERIFIED knowledge of what the customer actually texted and when; the
-- note must carry that evidence reference. This SQL is a reviewed
-- mechanism, NOT an operated desk workflow, and it is not authorized for
-- any real reconciliation or opt-in change.
--
-- Binding and freshness (v2):
--  * The resolution must match the claim's RECORDED action (persisted by
--    the claim RPC v3.7): 'apply_optin' requires action='optin'. A held
--    row without a recorded optin action is not resolvable as an opt-in.
--  * NEWER-KEYWORD GUARD: if the phone's keyword state points at a newer
--    event than this claim, resolution is REFUSED - a newer STOP/START
--    arrived after the held event, so acting on the stale claim could
--    undo it. Resolve the newest event first (re-verify), then this one
--    becomes the newest and resolves normally.
--  * CAS on held/uncertain; note required; audit appended; NEVER sends a
--    text (a desk-applied opt-in triggers no confirmation - separate
--    reviewed flow). 'keep_suppressed' changes no customer-visible state.
create or replace function public.inbound_desk_resolve(
  p_event_id text,
  p_resolution text,           -- 'apply_optin' | 'keep_suppressed'
  p_note text
) returns text                 -- 'resolved' | 'not_resolvable' | 'bad_resolution' | 'newer_keyword_exists'
language plpgsql security definer set search_path='public' as $$
declare
  v_claim public.inbound_events%rowtype;
  v_state public.sms_keyword_state%rowtype;
begin
  if p_resolution not in ('apply_optin','keep_suppressed') then return 'bad_resolution'; end if;
  if p_note is null or length(trim(p_note)) = 0 then return 'bad_resolution'; end if;

  select * into v_claim from public.inbound_events where event_id = p_event_id for update;
  if not found then return 'not_resolvable'; end if;
  if v_claim.status not in ('held','uncertain') then return 'not_resolvable'; end if;

  if p_resolution = 'apply_optin' then
    -- binding: the claim must be a recorded optin for this phone
    if v_claim.action is distinct from 'optin' or v_claim.from_phone is null then
      return 'not_resolvable';
    end if;
    -- freshness: refuse if a newer keyword event exists for this phone
    -- AND is itself unresolved. A newer event already terminal (done /
    -- failed / stale_event) is visible history, not a blocker: the desk
    -- can see exactly what it did. An unresolved newer event must be
    -- resolved first, newest-first, so nothing stale silently wins.
    select * into v_state from public.sms_keyword_state where phone = v_claim.from_phone;
    if found and v_state.last_event_id is distinct from p_event_id then
      declare v_newest_status text;
      begin
        select status into v_newest_status from public.inbound_events
         where event_id = v_state.last_event_id;
        if v_newest_status is null or v_newest_status in ('held','uncertain','processing','sending','db_done') then
          return 'newer_keyword_exists';
        end if;
      end;
    end if;
    delete from public.sms_opt_outs where phone = v_claim.from_phone;
    update public.sms_keyword_state
       set unknown_received_at = null, last_action = 'optin',
           last_event_id = p_event_id, updated_at = now()
     where phone = v_claim.from_phone;
  end if;

  update public.inbound_events
     set status = 'done',
         detail = detail || ' [desk ' || p_resolution || ': ' || p_note || ']',
         owner = 'desk',
         updated_at = now()
   where event_id = p_event_id
     and status in ('held','uncertain');
  if not found then return 'not_resolvable'; end if;
  return 'resolved';
end $$;
revoke all on function public.inbound_desk_resolve(text,text,text) from public, anon, authenticated;
grant execute on function public.inbound_desk_resolve(text,text,text) to service_role;
-- Apply safety: additive function only, no data change on apply.
