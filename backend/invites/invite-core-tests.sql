do $$
declare cust uuid; issuer uuid='11111111-1111-4111-8111-111111111111'; recipient uuid='22222222-2222-4222-8222-222222222222'; other_uid uuid='33333333-3333-4333-8333-333333333333'; j jsonb; first_link jsonb; bid uuid; n integer;
begin
 insert into auth.users(id,email,email_confirmed_at) values(recipient,'invite-test@example.invalid',now()),(other_uid,'wrong@example.invalid',now());
 insert into invite_stage.customers(owner_user_id) values(issuer) returning id into cust;
 perform set_config('request.jwt.claim.sub',issuer::text,true);
 for n in 1..5 loop
  j=invite_stage.issue(cust,'invite-test@example.invalid','req-'||n,now()+interval '7 days');
  if n=1 then first_link=j; end if;
 end loop;
 begin perform invite_stage.issue(cust,'extra@example.invalid','req-6',now()+interval '7 days');raise exception 'TEST quota failure'; exception when others then if sqlerrm<>'allowance exhausted' then raise; end if;end;
 j=invite_stage.issue(cust,'invite-test@example.invalid','req-1',now()+interval '7 days');
 if j->>'already_issued'<>'true' or j->>'token' is not null then raise exception 'TEST retry failure';end if;
 begin perform invite_stage.issue(cust,'different@example.invalid','req-1',now()+interval '7 days');raise exception 'TEST conflict'; exception when others then if sqlerrm<>'idempotency conflict' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',other_uid::text,true);
 begin perform invite_stage.issue(cust,'extra@example.invalid','unauth',now()+interval '7 days');raise exception 'TEST other issuer';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform invite_stage.set_allowance(cust,99);raise exception 'TEST quota admin';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',recipient::text,true);
 begin perform invite_stage.redeem(first_link->>'token','Buddy');raise exception 'TEST activation gate';exception when others then if sqlerrm<>'activation disabled' then raise;end if;end;
 update invite_stage.settings set activation_enabled=true;
 perform set_config('request.jwt.claim.sub',other_uid::text,true);
 begin perform invite_stage.redeem(first_link->>'token','Buddy');raise exception 'TEST recipient';exception when others then if sqlerrm<>'recipient mismatch' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',recipient::text,true);
 bid=invite_stage.redeem(first_link->>'token','Buddy');
 if invite_stage.redeem(first_link->>'token','Buddy')<>bid then raise exception 'TEST redemption retry';end if;
 if (select count(*) from invite_stage.businesses)<>1 then raise exception 'TEST duplicate business';end if;
 perform set_config('request.jwt.claim.sub',issuer::text,true);
 begin perform invite_stage.revoke((first_link->>'id')::uuid);raise exception 'TEST accepted revoke';exception when others then if sqlerrm<>'already accepted' then raise;end if;end;
 select id into bid from invite_stage.links where request_key='req-2';perform invite_stage.revoke(bid);
 perform invite_stage.issue(cust,'extra@example.invalid','req-6',now()+interval '7 days');
 update invite_stage.links set expires_at=now()-interval '1 second' where request_key='req-3';
 perform invite_stage.issue(cust,'extra@example.invalid','req-7',now()+interval '7 days');
 if (select count(*) from invite_stage.links where accepted_at is not null)<>1 then raise exception 'TEST accepted count';end if;
end $$;
select 'PASS: five cap, idempotency, wrong issuer, owner-only quota, disabled activation, verified-email match, atomic separate business, replay, revoke and expiry recovery' as result;
