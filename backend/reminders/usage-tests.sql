-- usage-tests.sql: LOCAL FIXTURE HARNESS for usage_monthly / count_sent_text
-- (day-and-briefs.sql). Self-contained: the file carries its own
-- begin/rollback. Run ONLY against a local/disposable Supabase instance -
-- never the live database (see billing-tests.sql for the residue rules).
--
-- What the trigger counts TODAY (grounded from source, Oct 24):
--   reminders-send.ts writes sms rows claimed -> 'accepted' (provider accept,
--   no sent_at). telnyx-webhook.ts moves accepted -> 'sent' on a carrier
--   'delivered' receipt (sets sent_at) or -> 'failed'. The dispatcher's
--   direct 'sent' write is the 'log' channel, which the trigger excludes.
--   So usage = carrier-confirmed sms deliveries, not provider accepts.
-- All "current behavior" assertions below DOCUMENT existing semantics; none
-- of them approve or change pricing/allowance/month-boundary semantics.

begin;

-- pin the session timezone: date_trunc('month', sent_at) buckets in the
-- SESSION timezone (UTC on Supabase). Pinned here so the boundary test is
-- deterministic; the business-local question is OPEN, not decided.
set local time zone 'UTC';

do $$
declare b1 uuid='d1111111-1111-4111-8111-111111111111';
        r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid;
        n int;
begin
 insert into public.businesses(id,name) values (b1,'usage-fixture-biz');

 -- T1: carrier-confirmed sms delivery counts once, current UTC month
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'sms','+15550000001','t1',now(),'usage-t1','test') returning id into r1;
 update public.reminders set status='accepted', accepted_at=now(), provider_id='p1' where id=r1;
 update public.reminders set status='sent', sent_at=now() where id=r1;
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now())::date;
 if n<>1 then raise exception 'TEST t1 delivery counts once'; end if;

 -- T2: a second confirmed delivery same month increments
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'sms','+15550000002','t2',now(),'usage-t2','test') returning id into r2;
 update public.reminders set status='accepted', accepted_at=now(), provider_id='p2' where id=r2;
 update public.reminders set status='sent', sent_at=now() where id=r2;
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now())::date;
 if n<>2 then raise exception 'TEST t2 same-month increment'; end if;

 -- T3: touching an already-sent row does NOT double count
 update public.reminders set error=null where id=r2 and status='sent';
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now())::date;
 if n<>2 then raise exception 'TEST t3 no double count'; end if;

 -- T4: log-channel sends are excluded
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'log','internal','t4',now(),'usage-t4','test') returning id into r3;
 update public.reminders set status='sent', sent_at=now() where id=r3;
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now())::date;
 if n<>2 then raise exception 'TEST t4 log channel excluded'; end if;

 -- T5: accepted -> failed never counts
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'sms','+15550000003','t5',now(),'usage-t5','test') returning id into r4;
 update public.reminders set status='accepted', accepted_at=now(), provider_id='p4' where id=r4;
 update public.reminders set status='failed', error='carrier reject' where id=r4;
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now())::date;
 if n<>2 then raise exception 'TEST t5 failed never counts'; end if;

 -- T6: a delivery 40 days ago lands in its own month row (structural reset)
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'sms','+15550000004','t6',now(),'usage-t6','test') returning id into r5;
 update public.reminders set status='sent', sent_at=now()-interval '40 days' where id=r5;
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now()-interval '40 days')::date;
 if n<>1 then raise exception 'TEST t6 prior month row'; end if;

 -- T7 (CURRENT BEHAVIOR, semantics open): a text sent 23:30 UTC-5 on the
 -- last day of a month is 04:30 UTC the next day and buckets into the NEXT
 -- month under the session-UTC date_trunc. This documents the boundary
 -- behavior; whether the allowance window should be business-local is NOT
 -- decided here.
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'sms','+15550000005','t7',now(),'usage-t7','test') returning id into r6;
 update public.reminders set status='sent', sent_at='2026-10-31T23:30:00-05:00'::timestamptz where id=r6;
 select texts into n from public.usage_monthly where business_id=b1 and month='2026-11-01';
 if n<>1 then raise exception 'TEST t7 utc boundary current behavior'; end if;
 -- the t7 row must NOT have joined the October bucket (still exactly the
 -- two October sends from t1/t2)
 select texts into n from public.usage_monthly where business_id=b1 and month='2026-10-01';
 if n<>2 then raise exception 'TEST t7 not bucketed local month'; end if;

 -- T8 (COVERAGE GAP, documented as current behavior): the trigger is
 -- AFTER UPDATE only. A row INSERTed already 'sent' (no code path does
 -- this today) is NOT counted. If a future send path ever inserts
 -- status='sent' directly, usage silently undercounts until an AFTER
 -- INSERT trigger is added.
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by,status,sent_at)
   values (b1,'sms','+15550000006','t8',now(),'usage-t8','test','sent',now()) returning id into r7;
 select texts into n from public.usage_monthly
   where business_id=b1 and month=date_trunc('month',now())::date;
 if n<>2 then raise exception 'TEST t8 insert-sent not counted (documented gap)'; end if;
end $$;

-- T9: least privilege on usage_monthly and v_usage_billing. Negative
-- control first: prove the role switch is binding.
set local role authenticated;

do $$
declare got int;
begin
 if current_role<>'authenticated' then raise exception 'TEST role switch binding'; end if;
 -- no RLS policies on usage_monthly: authenticated reads zero rows
 select count(*) into got from public.usage_monthly;
 if got<>0 then raise exception 'TEST usage rls read closed'; end if;
 -- no grant on the view: authenticated cannot read v_usage_billing
 begin
   perform count(*) from public.v_usage_billing;
   raise exception 'TEST usage view read denied';
 exception when insufficient_privilege then null;
 end;
 -- and cannot write usage directly
 begin
   insert into public.usage_monthly(business_id,month,texts) values ('d1111111-1111-4111-8111-111111111111','2026-01-01',1);
   raise exception 'TEST usage write denied';
 exception when insufficient_privilege then null;
 end;
end $$;

reset role;
do $$ begin raise notice 'usage-tests: all passed'; end $$;
rollback;
