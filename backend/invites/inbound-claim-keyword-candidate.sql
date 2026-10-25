-- INBOUND CLAIM-KEYWORD CANDIDATE v3 (REVIEW ONLY - NO APPLY AUTHORIZED)
-- v3 adds CHRONOLOGY GUARDS grounded in Telnyx's official webhook contract
-- (developers.telnyx.com/docs/development/api-fundamentals/webhooks/
-- receiving-webhooks, read 2026-10-25): "Do not depend on single delivery
-- or delivery order. Events can be concurrent, duplicated, delayed, or
-- delivered out of order. Reconcile state using occurred_at and product
-- resource identifiers where available." message.received carries
-- data.occurred_at (ISO 8601 event time) and meta.attempt (1-3).
-- Without a guard, an OLDER START processed after a NEWER STOP silently
-- re-enables texting - the dangerous inversion. occurred_at is the
-- provider-supplied reconciliation key Telnyx itself names; it is not a
-- guarantee of perfect chronology, so every ambiguous case fails CLOSED on
-- the safe side: suppression is cheap to over-apply, resubscribe is never
-- auto-applied without confidence.
--
-- Outcomes: 'claimed' | 'duplicate' | 'stale' | 'held'
--   stale - event's occurred_at is OLDER than the newest keyword event
--     already applied for this phone: claim recorded terminal as
--     'stale_event', suppression UNTOUCHED, no confirmation is sent (a
--     contradicting "you are resubscribed"/"you are unsubscribed" text
--     would be wrong). Redelivery dedupes like any terminal claim.
--   held  - a START whose occurred_at is missing, unparseable, or EQUAL to
--     the newest applied event: ambiguous resubscribe is NEVER auto-applied.
--     Claim recorded as 'held' for the desk; suppression PRESERVED.
--   A STOP in the same ambiguous cases still APPLIES (safe side).
--
-- Delivery-order note preserved from v2: concurrent same-phone events
-- serialize on the sms_opt_outs row lock; occurred_at comparison - not
-- arrival order - decides the mutation, so the resolved state converges to
-- latest-occurred_at-wins as events arrive. Remaining uncertainty:
-- occurred_at correctness is the provider's; ties/missing values are held
-- (START) or applied (STOP) per the safe-side rule above. A future
-- customer-visible policy (e.g. how ties are explained) remains an owner
-- decision; this candidate only prevents the silent unsafe inversion.
create table if not exists public.sms_keyword_state (
  phone text primary key,
  last_occurred_at timestamptz,        -- newest APPLIED keyword event time; null = unknown
  last_action text not null,           -- 'optout' | 'optin'
  last_event_id text not null,
  updated_at timestamptz not null default now()
);
alter table public.sms_keyword_state enable row level security;
revoke all on public.sms_keyword_state from public, anon, authenticated;
grant select, insert, update on public.sms_keyword_state to service_role;
alter table public.inbound_events add column if not exists occurred_at timestamptz;

create or replace function public.inbound_claim_keyword(
  p_event_id text,
  p_event_type text,
  p_from_phone text,
  p_action text,             -- 'optout' | 'optin'
  p_keyword text,            -- exact keyword received (audit)
  p_owner text,              -- per-attempt CAS owner id
  p_occurred_at text         -- raw data.occurred_at from the event envelope
) returns text               -- 'claimed' | 'duplicate' | 'stale' | 'held'
language plpgsql security definer set search_path='public' as $$
declare
  v_inserted boolean;
  v_occurred timestamptz;
  v_state public.sms_keyword_state;
  v_claim_status text := 'processing';
begin
  if p_action not in ('optout','optin') then raise exception 'bad action'; end if;
  -- provider timestamp: parse defensively; null means unknown (ambiguous)
  begin
    v_occurred := p_occurred_at::timestamptz;
  exception when others then
    v_occurred := null;
  end;
  select * into v_state from public.sms_keyword_state where phone = p_from_phone for update;

  if found and v_state.last_occurred_at is not null and v_occurred is not null
     and v_occurred < v_state.last_occurred_at then
    v_claim_status := 'stale_event';
  elsif p_action = 'optin'
     and (v_occurred is null
          or (found and v_state.last_occurred_at is not null and v_occurred = v_state.last_occurred_at)) then
    v_claim_status := 'held';
  end if;

  insert into public.inbound_events(event_id, event_type, from_phone, status, owner, version, occurred_at)
    values (p_event_id, p_event_type, p_from_phone, v_claim_status, p_owner, 1, v_occurred)
    on conflict (event_id) do nothing
    returning true into v_inserted;
  if v_inserted is distinct from true then return 'duplicate'; end if;

  if v_claim_status = 'stale_event' then return 'stale'; end if;
  if v_claim_status = 'held' then return 'held'; end if;

  if p_action = 'optout' then
    insert into public.sms_opt_outs(phone, keyword)
      values (p_from_phone, p_keyword)
      on conflict (phone) do update
        set opted_out_at = now(), keyword = excluded.keyword;
  else
    delete from public.sms_opt_outs where phone = p_from_phone;
  end if;
  insert into public.sms_keyword_state(phone, last_occurred_at, last_action, last_event_id)
    values (p_from_phone, v_occurred, p_action, p_event_id)
    on conflict (phone) do update
      set last_occurred_at = coalesce(excluded.last_occurred_at, public.sms_keyword_state.last_occurred_at),
          last_action = excluded.last_action,
          last_event_id = excluded.last_event_id,
          updated_at = now();
  -- coalesce: an applied event with an UNKNOWN occurred_at must not erase
  -- the newest known anchor, or a later genuinely-stale event could apply.
  return 'claimed';
end $$;
revoke all on function public.inbound_claim_keyword(text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.inbound_claim_keyword(text,text,text,text,text,text,text) to service_role;
-- Apply safety: additive table + column + create-or-replace function. The
-- 6-arg v2 signature is replaced by this 7-arg one; nothing else calls it.
-- No data change; no historical backfill (existing claims keep null
-- occurred_at, which the guard treats as unknown/ambiguous).
