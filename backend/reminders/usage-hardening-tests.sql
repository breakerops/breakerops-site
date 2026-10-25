-- usage-hardening-tests.sql: LOCAL FIXTURE HARNESS for the usage hardening
-- candidate. Self-contained begin/rollback; LOCAL/disposable instance only.
-- Proves the candidate closes a SIMULATED default-privilege exposure and
-- keeps the service send path working. Never run against the live DB.
begin;
set local time zone 'UTC';

-- fixture business
insert into public.businesses(id,name) values ('d2222222-2222-4222-8222-222222222222','hardening-fixture');

-- SIMULATE the exposure from the review: ambient default privileges that
-- hand reads to public roles (what a careless recreate could produce)
grant select on public.v_usage_billing to public, anon, authenticated;
grant select on public.usage_monthly to anon, authenticated;
grant truncate, references, trigger on public.usage_monthly to anon, authenticated;  -- the live oddity shape

-- APPLY the candidate body inside this transaction
revoke all on public.usage_monthly from public, anon, authenticated, service_role;
grant select, insert, update on public.usage_monthly to service_role;
revoke all on public.v_usage_billing from public, anon, authenticated, service_role;
grant select on public.v_usage_billing to service_role;
revoke all on public.reminders from public, anon, authenticated, service_role;
grant select, insert, update on public.reminders to service_role;

-- closed for public roles: view
set local role authenticated;
do $$ begin
 if current_role<>'authenticated' then raise exception 'TEST role switch binding'; end if;
 begin perform count(*) from public.v_usage_billing; raise exception 'TEST view closed authenticated';
 exception when insufficient_privilege then null; end;
 begin perform count(*) from public.usage_monthly; raise exception 'TEST table closed authenticated';
 exception when insufficient_privilege then null; end;
 begin truncate public.usage_monthly; raise exception 'TEST truncate gone authenticated';
 exception when insufficient_privilege then null; end;
 -- candidate is pure lockdown: authenticated has no reminders access either
 begin perform count(*) from public.reminders; raise exception 'TEST reminders closed authenticated';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
 if current_role<>'anon' then raise exception 'TEST role switch binding anon'; end if;
 begin perform count(*) from public.v_usage_billing; raise exception 'TEST view closed anon';
 exception when insufficient_privilege then null; end;
 begin perform count(*) from public.usage_monthly; raise exception 'TEST table closed anon';
 exception when insufficient_privilege then null; end;
end $$;
reset role;

-- service path still works end to end: full send cycle as service_role
set local role service_role;
do $$
declare n int; r uuid;
begin
 if current_role<>'service_role' then raise exception 'TEST role switch binding service'; end if;
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values ('d2222222-2222-4222-8222-222222222222','sms','+15550000009','h',now(),'hard-t1','test') returning id into r;
 update public.reminders set status='accepted', accepted_at=now(), provider_id='ph' where id=r;
 update public.reminders set status='sent', sent_at=now() where id=r;
 select texts into n from public.usage_monthly
   where business_id='d2222222-2222-4222-8222-222222222222' and month=date_trunc('month',now())::date;
 if n<>1 then raise exception 'TEST service send path counts after hardening'; end if;
 -- and the view reads for service_role
 perform count(*) from public.v_usage_billing;
end $$;
reset role;
do $$ begin raise notice 'usage-hardening-tests: all passed'; end $$;
rollback;
