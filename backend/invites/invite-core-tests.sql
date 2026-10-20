-- Phone-first core tests. Run as: begin; <core> <this file>; rollback;
do $$
declare cust uuid; cust2 uuid; issuer uuid='11111111-1111-4111-8111-111111111111'; other_uid uuid='33333333-3333-4333-8333-333333333333'; j jsonb; first_link uuid; n integer;
begin
 insert into invite_stage.customers(owner_user_id) values(issuer) returning id into cust;
 insert into invite_stage.customers(owner_user_id) values(other_uid) returning id into cust2;
 perform set_config('request.jwt.claim.sub',issuer::text,true);

 -- five cap, idempotency, changed-recipient conflict
 for n in 1..5 loop
  j=invite_stage.issue(cust,'+1555000'||lpad(n::text,4,'0'),'req-'||n,now()+interval '7 days');
  if n=1 then first_link=(j->>'id')::uuid; end if;
 end loop;
 begin perform invite_stage.issue(cust,'+15550009999','req-6',now()+interval '7 days');raise exception 'TEST quota'; exception when others then if sqlerrm<>'allowance exhausted' then raise;end if;end;
 j=invite_stage.issue(cust,'+15550000001','req-1',now()+interval '7 days');
 if j->>'already_issued'<>'true' then raise exception 'TEST retry';end if;
 begin perform invite_stage.issue(cust,'+15550000077','req-1',now()+interval '7 days');raise exception 'TEST conflict'; exception when others then if sqlerrm<>'idempotency conflict' then raise;end if;end;

 -- wrong actor, non-admin allowance/binding
 perform set_config('request.jwt.claim.sub',other_uid::text,true);
 begin perform invite_stage.issue(cust,'+15550000088','unauth',now()+interval '7 days');raise exception 'TEST other issuer';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform invite_stage.set_allowance(cust,99);raise exception 'TEST quota admin';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform invite_stage.bind_phone(cust,'+15551112222');raise exception 'TEST bind admin';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;

 -- same buddy phone invited by two customers: second rejected
 perform set_config('request.jwt.claim.sub',other_uid::text,true);
 begin perform invite_stage.issue(cust2,'+15550000001','other-1',now()+interval '7 days');raise exception 'TEST dup phone';exception when others then if sqlerrm<>'phone already invited' then raise;end if;end;

 -- redemption gate, then redeem-on-inbound flow
 begin perform invite_stage.redeem_on_inbound('+15550000001');raise exception 'TEST gate';exception when others then if sqlerrm<>'activation disabled' then raise;end if;end;
 update invite_stage.settings set activation_enabled=true;
 j=invite_stage.redeem_on_inbound('+15550000001');
 if j->>'status'<>'admitted' or (j->>'inviter_customer_id')::uuid<>cust then raise exception 'TEST admit';end if;
 if (select name from invite_stage.businesses where id=(j->>'business_id')::uuid) is not null then raise exception 'TEST nameless business';end if;
 if invite_stage.redeem_on_inbound('+15550000001')->>'status'<>'member' then raise exception 'TEST member retry';end if;
 if invite_stage.redeem_on_inbound('+15550000001')->>'business_id'<>j->>'business_id' then raise exception 'TEST same business';end if;
 if invite_stage.redeem_on_inbound('+15559998888')->>'status'<>'none' then raise exception 'TEST none';end if;
 if (select count(*) from invite_stage.businesses)<>1 then raise exception 'TEST dup business';end if;

 -- inviting an admitted phone, or a customer's phone, rejected
 perform set_config('request.jwt.claim.sub',issuer::text,true);
 begin perform invite_stage.issue(cust,'+15550000001','req-7',now()+interval '7 days');raise exception 'TEST admitted phone';exception when others then if sqlerrm<>'already admitted' then raise;end if;end;
 perform set_config('request.jwt.claim.sub','80f2d1a2-7634-40e8-abf6-904e0aae73b4',true);
 perform invite_stage.bind_phone(cust2,'+15551112222');
 perform set_config('request.jwt.claim.sub',issuer::text,true);
 begin perform invite_stage.issue(cust,'+15551112222','req-8',now()+interval '7 days');raise exception 'TEST customer phone';exception when others then if sqlerrm<>'phone is a customer' then raise;end if;end;

 -- revoke frees slot and phone; accepted stays counted and cannot be revoked
 begin perform invite_stage.revoke(first_link);raise exception 'TEST accepted revoke';exception when others then if sqlerrm<>'already accepted' then raise;end if;end;
 perform invite_stage.revoke((select id from invite_stage.links where request_key='req-2'));
 perform invite_stage.issue(cust,'+15550000002','req-9',now()+interval '7 days');

 -- expired pending invite is reclaimed on re-issue to that phone
 update invite_stage.links set expires_at=now()-interval '1 second' where request_key='req-3';
 perform invite_stage.issue(cust,'+15550000003','req-10',now()+interval '7 days');
 if (select count(*) from invite_stage.links where intended_phone='+15550000003' and accepted_at is null and revoked_at is null)<>1 then raise exception 'TEST reclaim';end if;

 -- account binding: admin-only, conflict-safe
 perform set_config('request.jwt.claim.sub',issuer::text,true);
 begin perform invite_stage.bind_business_account('+15550000001',issuer);raise exception 'TEST bind forbidden';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 perform set_config('request.jwt.claim.sub','80f2d1a2-7634-40e8-abf6-904e0aae73b4',true);
 if invite_stage.bind_business_account('+15550000001',other_uid) is null then raise exception 'TEST bind';end if;
 begin perform invite_stage.bind_business_account('+15550000001',issuer);raise exception 'TEST rebind';exception when others then if sqlerrm<>'business already bound' then raise;end if;end;
end $$;
select 'PASS: phone cap, idempotency, dup-phone across customers, gate, redeem-on-inbound admitted/member/none, admitted/customer phone rejected, revoke frees phone+slot, expired reclaim, account binding' as result;
