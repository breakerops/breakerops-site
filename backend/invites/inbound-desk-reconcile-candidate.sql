-- DESK RECONCILIATION CANDIDATE v2 (REVIEW ONLY - NO APPLY AUTHORIZED)
-- The ONLY resolution path for held/uncertain claims and the ONLY
-- horizon-clear. Service-role only: the desk is Matt operating with
-- VERIFIED knowledge of what the customer actually texted and when; the
-- note must carry that evidence reference. This SQL is a reviewed
-- mechanism, NOT an operated desk workflow, and it is not authorized for
-- any real reconciliation or opt-in change.
--
-- Binding and freshness (v3, per independent review D1/D2/D3):
--  * 'apply_optin' ONLY on status='held' claims with recorded
--    action='optin' (persisted by the claim RPC v3.7). An 'uncertain'
--    claim - including a STOP confirmation with an unknown send outcome -
--    can NEVER flip suppression here; uncertain means verify-by-idem-key,
--    and non-keyword swept rows have action NULL and are refused.
--  * GENERATION GUARD (event chain, not timestamps): apply_optin requires
--    that NO keyword event applied after this claim was recorded. The claim
--    RPC stamps every claim with the state generation it saw under the row
--    lock and increments that generation on every apply, so the check is a
--    single integer compare - no mutable updated_at, no cross-clock
--    comparison, and the provider-timestamp anchor stays in its own clock
--    domain. If anything applied after the held claim (even already
--    terminal), the customer's newer word stands: REFUSED; the customer
--    re-texting creates a new event to resolve. Claims predating the
--    generation column (state_gen NULL) are refused - safe side.
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
    -- binding: held claims only, recorded optin only, phone present
    if v_claim.status is distinct from 'held'
       or v_claim.action is distinct from 'optin'
       or v_claim.from_phone is null then
      return 'not_resolvable';
    end if;
    -- generation guard: refuse if anything applied after this claim
    if v_claim.state_gen is null then return 'newer_keyword_exists'; end if;
    select * into v_state from public.sms_keyword_state where phone = v_claim.from_phone;
    if found and v_state.gen is distinct from v_claim.state_gen then
      return 'newer_keyword_exists';
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
