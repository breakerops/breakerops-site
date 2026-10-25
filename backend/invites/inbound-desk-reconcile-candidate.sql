-- DESK RECONCILIATION CANDIDATE (REVIEW ONLY - NO APPLY AUTHORIZED)
-- The ONLY way a held or uncertain claim resolves, and the ONLY way an
-- unknown-ts horizon clears. Without this path, held STARTs are permanent
-- (documented ops dependency). Service-role only: the desk is Matt
-- operating with verified knowledge of what the customer actually texted
-- and when (e.g. confirmed with the carrier logs or the customer directly).
--
-- Hard rules:
--  * NEVER sends a text. A desk-applied opt-in does NOT trigger the
--    resubscribe confirmation here; if the customer should get one, that is
--    a separate reviewed flow. This function resolves records only.
--  * Only rows in 'held' or 'uncertain' can be resolved (CAS); anything
--    else is refused.
--  * Every resolution appends an audit line to detail with the note; the
--    note is required.
--  * 'apply_optin' additionally deletes suppression and clears the horizon
--    (the desk is asserting the resubscribe is VERIFIED real and newer than
--    any ambiguous STOP). 'keep_suppressed' leaves suppression and the
--    horizon exactly as they are.
create or replace function public.inbound_desk_resolve(
  p_event_id text,
  p_resolution text,           -- 'apply_optin' | 'keep_suppressed'
  p_note text
) returns text                 -- 'resolved' | 'not_resolvable' | 'bad_resolution'
language plpgsql security definer set search_path='public' as $$
declare
  v_claim public.inbound_events%rowtype;
begin
  if p_resolution not in ('apply_optin','keep_suppressed') then return 'bad_resolution'; end if;
  if p_note is null or length(trim(p_note)) = 0 then return 'bad_resolution'; end if;

  select * into v_claim from public.inbound_events where event_id = p_event_id for update;
  if not found then return 'not_resolvable'; end if;
  if v_claim.status not in ('held','uncertain') then return 'not_resolvable'; end if;

  if p_resolution = 'apply_optin' and v_claim.from_phone is not null then
    delete from public.sms_opt_outs where phone = v_claim.from_phone;
    -- verified resubscribe closes the uncertainty horizon for this phone
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
     and status in ('held','uncertain');   -- CAS: still resolvable
  if not found then return 'not_resolvable'; end if;
  return 'resolved';
end $$;
revoke all on function public.inbound_desk_resolve(text,text,text) from public, anon, authenticated;
grant execute on function public.inbound_desk_resolve(text,text,text) to service_role;
-- Apply safety: additive function only, no data change on apply.
