-- lifecycle-tests.sql: LOCAL FIXTURE HARNESS for deletion.sql
-- (deletion_preview / business_deactivate / business_delete).
-- Self-contained begin/rollback; LOCAL/disposable instance only. Never live.
-- Fixture stubs for tables not defined in the repo carry only the columns
-- these functions touch - stub fidelity limitation, same as the is_member
-- shim. Function CALLS run as the authenticated role (auth.uid() paths);
-- effect ASSERTIONS run as the owner, since they inspect table state, not
-- access rights.
begin;
set local time zone 'UTC';

-- part 1 (owner): fixtures
do $$
declare b1 uuid='e1111111-1111-4111-8111-111111111111';
        b2 uuid='e2222222-2222-4222-8222-222222222222';
        b3 uuid='e3333333-3333-4333-8333-333333333333';
        u1 uuid='e1111111-aaaa-4111-8111-111111111111';
        u2 uuid='e2222222-aaaa-4222-8222-222222222222';
begin
 insert into public.businesses(id,name) values (b1,'lc-b1'),(b2,'lc-b2'),(b3,'lc-b3');
 insert into public.business_members(business_id,user_id,role) values
   (b1,u1,'owner'),(b1,u2,'member'),(b2,u2,'owner');
 insert into public.brief_subscriptions(business_id,recipient_channel,recipient,send_time)
   values (b1,'sms','+15550000010','07:00');
 insert into public.day_tokens(business_id,token) values (b1,'tok-b1');
 insert into public.push_subscriptions(user_id) values (u1),(u2);
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
   values (b1,'sms','+15550000011','pend',now(),'lc-p1','test');
 insert into public.reminders(business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by,status,accepted_at,provider_id)
   values (b1,'sms','+15550000012','acc',now(),'lc-p2','test','accepted',now(),'prov-1');
 insert into public.usage_monthly(business_id,month,texts) values (b1,date_trunc('month',now())::date,7);
 insert into public.calendar_items(business_id) values (b1),(b1);
end $$;

-- results mailbox for cross-role assertions
create temp table lc_results(k text primary key, v text);
grant all on lc_results to authenticated;  -- test mailbox only, session-scoped

-- part 2 (authenticated): gates
set local role authenticated;
do $$
declare b1 uuid='e1111111-1111-4111-8111-111111111111';
        b3 uuid='e3333333-3333-4333-8333-333333333333';
        u1 uuid='e1111111-aaaa-4111-8111-111111111111';
        u2 uuid='e2222222-aaaa-4222-8222-222222222222';
        n bigint;
begin
 if current_role<>'authenticated' then raise exception 'TEST role switch binding'; end if;
 perform set_config('request.jwt.claim.sub',u2::text,true);
 perform set_config('request.jwt.claims', json_build_object('sub',u2,'role','authenticated')::text, true);
 select item_count into n from public.deletion_preview(b1) where scope='reminders';
 insert into lc_results values ('preview_member_reminders', n::text);
 perform set_config('request.jwt.claim.sub',u1::text,true);
 perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
 begin
   perform count(*) from public.deletion_preview(b3);
   insert into lc_results values ('preview_nonmember','NO-ERROR');
 exception when others then insert into lc_results values ('preview_nonmember', sqlerrm); end;
 perform set_config('request.jwt.claim.sub',u2::text,true);
 perform set_config('request.jwt.claims', json_build_object('sub',u2,'role','authenticated')::text, true);
 begin
   perform public.business_deactivate(b1);
   insert into lc_results values ('deactivate_member','NO-ERROR');
 exception when others then insert into lc_results values ('deactivate_member', sqlerrm); end;
 begin
   perform public.business_delete(b1);
   insert into lc_results values ('delete_member','NO-ERROR');
 exception when others then insert into lc_results values ('delete_member', sqlerrm); end;
 perform set_config('request.jwt.claim.sub',u1::text,true);
 perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
 begin
   perform public.business_delete(b1);
   insert into lc_results values ('delete_before_quiesce','NO-ERROR');
 exception when others then insert into lc_results values ('delete_before_quiesce', sqlerrm); end;
end $$;
reset role;

-- part 3 (owner path): deactivate -> drain refusal -> (settle) -> delete
set local role authenticated;
do $$
declare b1 uuid='e1111111-1111-4111-8111-111111111111';
        u1 uuid='e1111111-aaaa-4111-8111-111111111111';
begin
 perform set_config('request.jwt.claim.sub',u1::text,true);
 perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
 insert into lc_results values ('deactivate_owner', public.business_deactivate(b1)::text);
 insert into lc_results values ('deactivate_owner_again', public.business_deactivate(b1)::text);
 begin
   perform public.business_delete(b1);
   insert into lc_results values ('delete_during_drain','NO-ERROR');
 exception when others then insert into lc_results values ('delete_during_drain', sqlerrm); end;
end $$;
reset role;

update public.reminders set status='failed', error='carrier reject'
 where business_id='e1111111-1111-4111-8111-111111111111' and status='accepted';

set local role authenticated;
do $$
declare b1 uuid='e1111111-1111-4111-8111-111111111111';
        u1 uuid='e1111111-aaaa-4111-8111-111111111111';
begin
 perform set_config('request.jwt.claim.sub',u1::text,true);
 perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
 insert into lc_results values ('delete_owner', public.business_delete(b1)::text);
end $$;
reset role;

-- part 4 (owner): every assertion
do $$
declare b1 uuid='e1111111-1111-4111-8111-111111111111';
        u1 uuid='e1111111-aaaa-4111-8111-111111111111';
        u2 uuid='e2222222-aaaa-4222-8222-222222222222';
begin
 if (select v from lc_results where k='preview_member_reminders')<>'2' then raise exception 'TEST preview member sees inventory'; end if;
 if (select v from lc_results where k='preview_nonmember')<>'forbidden' then raise exception 'TEST preview forbidden nonmember'; end if;
 if (select v from lc_results where k='deactivate_member')<>'owner role required' then raise exception 'TEST deactivate member refused'; end if;
 if (select v from lc_results where k='delete_member')<>'owner role required' then raise exception 'TEST delete member refused'; end if;
 if (select v from lc_results where k='delete_before_quiesce')<>'quiesce first' then raise exception 'TEST delete before quiesce refused'; end if;
 if (select v from lc_results where k='delete_during_drain') not like 'drain first%' then raise exception 'TEST drain barrier'; end if;
 if (select lifecycle from public.businesses where id=b1)<>'purged' then raise exception 'TEST tombstone purged'; end if;
 if (select purged_at from public.businesses where id=b1) is null then raise exception 'TEST purged_at set'; end if;
 if exists (select 1 from public.brief_subscriptions where business_id=b1) then raise exception 'TEST briefs purged'; end if;
 if exists (select 1 from public.day_tokens where business_id=b1) then raise exception 'TEST tokens gone'; end if;
 if exists (select 1 from public.reminders where business_id=b1) then raise exception 'TEST reminders purged'; end if;
 if exists (select 1 from public.calendar_items where business_id=b1) then raise exception 'TEST items purged'; end if;
 if exists (select 1 from public.business_members where business_id=b1) then raise exception 'TEST members purged'; end if;
 if exists (select 1 from public.push_subscriptions where user_id=u1) then raise exception 'TEST single-biz push removed'; end if;
 if not exists (select 1 from public.push_subscriptions where user_id=u2) then raise exception 'TEST multi-biz push preserved'; end if;
 if (select texts from public.usage_monthly where business_id=b1)<>7 then raise exception 'TEST usage retained'; end if;
end $$;
do $$ begin raise notice 'lifecycle-tests: all passed'; end $$;
rollback;
