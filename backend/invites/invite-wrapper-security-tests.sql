-- invite-wrapper-security-tests.sql: LOCAL FIXTURE HARNESS for
-- service-wrappers.sql. Self-contained begin/rollback; LOCAL only, never live.
-- Covers: identity-bleed (claim.sub preserved across wrapper calls on BOTH
-- success and exception paths) and role-negative (anon/authenticated can
-- never execute the service wrappers). Run AFTER fixture + invite-core.sql +
-- service-wrappers.sql are loaded.
begin;
set local time zone 'UTC';

-- fixtures as owner
do $$
begin
 insert into invite_stage.customers(id, owner_user_id, phone) values
   ('f1111111-1111-4111-8111-111111111111','80f2d1a2-7634-40e8-abf6-904e0aae73b4','+15551110000');
end $$;

-- part 1: identity bleed, as the trusted service role
set local role service_role;
do $$
declare prior text; j jsonb; cust uuid='f1111111-1111-4111-8111-111111111111'; jake uuid='80f2d1a2-7634-40e8-abf6-904e0aae73b4';
begin
 if current_role<>'service_role' then raise exception 'TEST role switch binding'; end if;
 -- simulate the desk's own session identity (NOT the customer owner)
 perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000000',true);

 -- success path: issue
 j := public.invite_issue_by_phone('+15551110000','+15551110001','sec-1',now()+interval '7 days');
 if current_setting('request.jwt.claim.sub',true)<>'dddddddd-0000-4000-8000-000000000000'
   then raise exception 'TEST bleed after issue success'; end if;
 -- success path: set allowance / bind phone / revoke (revoke needs a link id)
 perform public.invite_set_allowance(jake, cust, 4);
 if current_setting('request.jwt.claim.sub',true)<>'dddddddd-0000-4000-8000-000000000000'
   then raise exception 'TEST bleed after allowance'; end if;
 perform public.invite_bind_phone(jake, cust, '+15551110000');
 if current_setting('request.jwt.claim.sub',true)<>'dddddddd-0000-4000-8000-000000000000'
   then raise exception 'TEST bleed after bind'; end if;
 perform public.invite_revoke(jake, (j->>'id')::uuid);
 if current_setting('request.jwt.claim.sub',true)<>'dddddddd-0000-4000-8000-000000000000'
   then raise exception 'TEST bleed after revoke'; end if;

 -- exception path: unknown customer phone raises; identity must survive
 begin
   perform public.invite_issue_by_phone('+15559999999','+15551110002','sec-2',now()+interval '7 days');
   raise exception 'TEST unknown phone accepted';
 exception when others then
   if sqlerrm='TEST unknown phone accepted' then raise; end if;
 end;
 if current_setting('request.jwt.claim.sub',true)<>'dddddddd-0000-4000-8000-000000000000'
   then raise exception 'TEST bleed after exception'; end if;
end $$;
reset role;

-- part 2: role-negative - neither authenticated nor anon may execute wrappers
set local role authenticated;
do $$ begin
 if current_role<>'authenticated' then raise exception 'TEST role switch binding auth'; end if;
 begin perform public.invite_issue_by_phone('+15551110000','+15551110003','sec-3',now()); raise exception 'TEST auth issue denied';
   exception when insufficient_privilege then null; end;
 begin perform public.invite_redeem_on_inbound('+15551110001'); raise exception 'TEST auth redeem denied';
   exception when insufficient_privilege then null; end;
 begin perform public.invite_revoke('80f2d1a2-7634-40e8-abf6-904e0aae73b4', gen_random_uuid()); raise exception 'TEST auth revoke denied';
   exception when insufficient_privilege then null; end;
 begin perform public.invite_set_allowance('80f2d1a2-7634-40e8-abf6-904e0aae73b4', gen_random_uuid(), 5); raise exception 'TEST auth allowance denied';
   exception when insufficient_privilege then null; end;
 begin perform public.invite_bind_phone('80f2d1a2-7634-40e8-abf6-904e0aae73b4', gen_random_uuid(), '+15550000000'); raise exception 'TEST auth bind denied';
   exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
 if current_role<>'anon' then raise exception 'TEST role switch binding anon'; end if;
 begin perform public.invite_issue_by_phone('+15551110000','+15551110004','sec-4',now()); raise exception 'TEST anon issue denied';
   exception when insufficient_privilege then null; end;
 begin perform public.invite_redeem_on_inbound('+15551110001'); raise exception 'TEST anon redeem denied';
   exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin raise notice 'invite-wrapper-security-tests: all passed'; end $$;
rollback;
