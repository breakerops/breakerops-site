-- billing.sql: NONLIVE billing scaffold for BreakerOps.
-- Status: placeholder only. No Stripe account, keys, checkout or webhook are
-- connected. Every row status here is a DRAFT label; nothing in this file
-- charges, entitles, limits, or promises anything to anyone. Jake's launch
-- decision (flat $20/user/month, 1500 texts target unpublished) is recorded
-- as inert reference data, not enforceable config.

-- One billing profile per business. stripe_* columns stay NULL until Jake
-- authorizes account creation (entity choice pending: LLC-first stands).
create table if not exists public.billing_profiles (
  business_id uuid primary key references public.businesses(id),
  stripe_customer_id text,                -- NULL: no Stripe customer exists
  stripe_subscription_id text,            -- NULL: no subscription exists
  plan_code text not null default 'pilot_flat_20',   -- label only
  price_cents integer not null default 2000,         -- $20 flat, reference only
  status text not null default 'draft'
    check (status in ('draft','trialing','active','past_due','canceled')),
  -- 'draft' = not connected to any processor; 'active' is impossible until a
  -- real webhook confirms it. No code path should treat 'draft' as paid.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.billing_profiles enable row level security;
-- Members may READ their own business's billing label; only service role writes.
create policy billing_profiles_member_read on billing_profiles for select to authenticated
  using (is_member(business_id));
grant select on public.billing_profiles to authenticated;  -- policy is dead without this grant (found by billing-tests)
revoke insert, update, delete on public.billing_profiles from anon, authenticated;

-- Append-only payment event log. Webhook stub writes here with the raw
-- provider event id; placeholders only until a real signing secret exists.
create table if not exists public.billing_events (
  id bigint generated always as identity primary key,
  business_id uuid references public.businesses(id),
  provider text not null default 'placeholder',
  provider_event_id text,                 -- dedupe key once real
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;  -- service role only

-- Entitlement check for future allowance enforcement. NONLIVE: always returns
-- 'pilot_manual' while the business exists and is not purged - the manual
-- pilot model Jake approved for the bounded pilot. Allowance enforcement
-- (1500/mo) is deliberately NOT implemented here; that decision is open.
create or replace function public.billing_entitlement(p_business uuid)
returns text language sql security definer set search_path='public' stable as $$
  -- access rule (fail closed), per Supabase JWT semantics: the trusted
  -- server path is identified by the role claim itself
  -- (service_role JWTs carry no sub); user callers must present a non-null
  -- sub AND be a member of the business. An authenticated request with a
  -- missing or empty sub gets the same NULL as any other unauthorized
  -- caller, so the function is never an existence/lifecycle oracle.
  select case
    when b.lifecycle = 'purged' then 'none'
    else 'pilot_manual'
  end
  from public.businesses b
  where b.id = p_business
    and (
      coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or (auth.uid() is not null and is_member(b.id, auth.uid()))
    );
$$;
revoke all on function public.billing_entitlement(uuid) from public, anon;
grant execute on function public.billing_entitlement(uuid) to authenticated, service_role;
