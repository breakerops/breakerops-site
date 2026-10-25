-- INBOUND CLAIM-KEYWORD CANDIDATE (REVIEW ONLY - NO APPLY AUTHORIZED)
-- Closes the F1 window in telnyx-inbound: today the claim row is inserted in
-- one statement and the STOP/START suppression mutation in a LATER one, so a
-- crash between them (with provider retries exhausted) silently loses a STOP.
-- This RPC makes claim + suppression ONE transaction for keyword-class
-- events: both land or neither does. Chosen over the send-side held-claim
-- prototype (candidate-1) because it needs no coupling to reminders-send and
-- no later-START tension: suppression state is only ever mutated atomically
-- with a fresh claim, so an old STOP redelivery can never resurrect a
-- suppression a later START removed (duplicate -> no re-upsert).
-- Ordering: concurrent STOP and START for the same phone serialize on the
-- sms_opt_outs row lock; last commit wins, matching "last text wins".
-- CAS/idempotency preserved: claims are still inserted with
-- status='processing', owner=attempt id, version=1; all later transitions
-- are the existing owner/version compare-and-swaps. No blind send: this RPC
-- only records claim + suppression; the confirmation text still goes
-- through the existing intent/CAS/send path.
create or replace function public.inbound_claim_keyword(
  p_event_id text,
  p_event_type text,
  p_from_phone text,
  p_action text,             -- 'optout' | 'optin'
  p_keyword text,            -- exact keyword received (audit)
  p_owner text               -- per-attempt CAS owner id
) returns text               -- 'claimed' | 'duplicate'
language plpgsql security definer set search_path='public' as $$
declare v_inserted boolean;
begin
  if p_action not in ('optout','optin') then raise exception 'bad action'; end if;
  insert into public.inbound_events(event_id, event_type, from_phone, status, owner, version)
    values (p_event_id, p_event_type, p_from_phone, 'processing', p_owner, 1)
    on conflict (event_id) do nothing
    returning true into v_inserted;
  if v_inserted is distinct from true then return 'duplicate'; end if;
  if p_action = 'optout' then
    insert into public.sms_opt_outs(phone, keyword)
      values (p_from_phone, p_keyword)
      on conflict (phone) do update
        set opted_out_at = now(), keyword = excluded.keyword;
  else
    delete from public.sms_opt_outs where phone = p_from_phone;
  end if;
  return 'claimed';
end $$;
revoke all on function public.inbound_claim_keyword(text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.inbound_claim_keyword(text,text,text,text,text,text) to service_role;
-- Apply safety: additive function only; no data change; no existing behavior
-- changes until the handler calls it. Idempotent (create or replace).
