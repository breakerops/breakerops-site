-- billing-tests.sql: LOCAL FIXTURE HARNESS for the NONLIVE billing scaffold
-- (billing.sql). Self-contained: the file carries its own begin/rollback.
--
-- DO NOT RUN AGAINST THE LIVE/PRODUCTION DATABASE. A rolled-back run is not
-- effect-free: billing_events.id is GENERATED ALWAYS AS IDENTITY and identity
-- sequence increments are NOT rolled back. This file inserts one
-- billing_events row, so every run advances the live sequence permanently.
-- Run only against a local/disposable Supabase instance.
--
-- Fixture users are SYNTHETIC and created inside the transaction
-- (auth.users insert below). Public-history note: commit 8601d826 used a
-- real user UUID as the member fixture; this commit replaces it with a
-- synthetic local user. History is preserved, not rewritten.
--
-- Scope: schema invariants, entitlement function, RLS/grants. The TS
-- functions (billing-checkout, billing-webhook) are env-gated placeholders:
-- without BILLING_MODE=placeholder both answer 503 and change nothing; with
-- it they write only 'draft'/placeholder rows. No code path sets
-- status<>'draft' (asserted by inspection); live HTTP exercise waits for the
-- deploy gate.

begin;

-- mirror the repo-fixed billing.sql grant inside this transaction (rolls
-- back). The grant fix (commit d3d5b671) is repo-only pending deploy review;
-- the live DB still lacks it. Without this mirror the member-read policy is
-- dead and the part-2 tests fail for the wrong reason.
grant select on public.billing_profiles to authenticated;

-- part 1 (as table owner): fixtures, entitlement, defaults, check constraint
do $$
declare b1 uuid='b1111111-1111-4111-8111-111111111111';
        b2 uuid='b2222222-2222-4222-8222-222222222222';
        uid1 uuid='c1111111-1111-4111-8111-111111111111';
        t text;
begin
 -- synthetic local fixture user (business_members.user_id FK -> auth.users)
 insert into auth.users(id) values (uid1);

 insert into public.businesses(id,name,lifecycle) values (b1,'TEST billing active','active');
 insert into public.businesses(id,name,lifecycle) values (b2,'TEST billing purged','purged');
 insert into public.business_members(business_id,user_id) values (b1,uid1);

 -- entitlement: active business -> pilot_manual, purged -> none, unknown -> null
 if public.billing_entitlement(b1)<>'pilot_manual' then raise exception 'TEST entitlement active'; end if;
 if public.billing_entitlement(b2)<>'none' then raise exception 'TEST entitlement purged'; end if;
 if public.billing_entitlement('d9999999-9999-4999-8999-999999999999') is not null then raise exception 'TEST entitlement unknown'; end if;

 -- profile defaults: inert draft label, stripe columns NULL, $20 reference only
 insert into public.billing_profiles(business_id) values (b1);
 select status into t from public.billing_profiles where business_id=b1;
 if t<>'draft' then raise exception 'TEST default status'; end if;
 if exists(select 1 from public.billing_profiles where business_id=b1
           and (stripe_customer_id is not null or stripe_subscription_id is not null
                or plan_code<>'pilot_flat_20' or price_cents<>2000))
 then raise exception 'TEST default shape'; end if;

 -- status check constraint rejects unknown labels
 begin
  insert into public.billing_profiles(business_id,status) values (b2,'bogus');
  raise exception 'TEST status check';
 exception when check_violation then null;
 end;
end $$;

-- part 2: switch to the authenticated role for RLS/grant tests
set local role authenticated;

do $$
declare uid1 uuid='c1111111-1111-4111-8111-111111111111';
        uid2 uuid='c2222222-2222-4222-8222-222222222222';
        b1 uuid='b1111111-1111-4111-8111-111111111111';
        b2 uuid='b2222222-2222-4222-8222-222222222222';
        n integer;
begin
 -- member reads own business profile only
 perform set_config('request.jwt.claim.sub',uid1::text,true);
 select count(*) into n from public.billing_profiles;
 if n<>1 then raise exception 'TEST member read own'; end if;

 -- non-member reads nothing
 perform set_config('request.jwt.claim.sub',uid2::text,true);
 select count(*) into n from public.billing_profiles;
 if n<>0 then raise exception 'TEST nonmember read'; end if;

 -- authenticated can never write billing_profiles (service role only)
 begin
  insert into public.billing_profiles(business_id) values (b2);
  raise exception 'TEST auth insert profiles';
 exception when insufficient_privilege then null;
 end;
 begin
  update public.billing_profiles set status='active' where business_id=b1;
  raise exception 'TEST auth update profiles';
 exception when insufficient_privilege then null;
 end;

 -- billing_events: authenticated can neither write nor read
 begin
  insert into public.billing_events(business_id,event_type,payload) values (b1,'test','{}');
  raise exception 'TEST auth insert events';
 exception when insufficient_privilege then null;
 end;
 begin
  perform count(*) from public.billing_events;
  raise exception 'TEST auth read events';
 exception when insufficient_privilege then null;
 end;
end $$;

-- part 3: back to owner role; service-path append changes nothing
reset role;

do $$
declare b1 uuid='b1111111-1111-4111-8111-111111111111';
begin
 insert into public.billing_events(business_id,provider,provider_event_id,event_type,payload)
  values (b1,'placeholder','evt-test-1','checkout.session.completed','{"test":true}');
 -- even a payment-shaped event leaves the profile an inert draft
 if (select status from public.billing_profiles where business_id=b1)<>'draft'
 then raise exception 'TEST activation guard'; end if;
 raise notice 'billing-tests: all passed';
end $$;

rollback;
