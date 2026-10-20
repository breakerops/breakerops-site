-- Rollback tests for service wrappers, phone binding, peek, and provisioning.
-- Run as: begin; <this file>; rollback;  (nothing persists)
do $$
declare
  cust uuid; j jsonb; bid uuid; pid uuid; tok text;
  jake uuid='80f2d1a2-7634-40e8-abf6-904e0aae73b4';
  other uuid='44444444-4444-4444-8444-444444444444';
  recipient2 uuid='55555555-5555-4555-8555-555555555555';
begin
  insert into invite_stage.customers(owner_user_id) values(jake) returning id into cust;

  -- wrapper issues as verified owner
  j = public.invite_issue(jake, cust, 'wrap@example.invalid', 'wrap-1', now()+interval '7 days');
  if j->>'token' is null then raise exception 'TEST wrapper issue'; end if;
  tok = j->>'token';

  -- wrapper passes actor through: wrong actor still forbidden
  begin perform public.invite_issue(other, cust, 'x@example.invalid','wrap-2',now()+interval '7 days');
    raise exception 'TEST wrapper actor';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;

  -- allowance control: non-admin forbidden, admin applies
  begin perform public.invite_set_allowance(other, cust, 9);
    raise exception 'TEST wrapper allowance';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
  perform public.invite_set_allowance(jake, cust, 7);
  if (select allowance from invite_stage.customers where id=cust)<>7 then raise exception 'TEST allowance apply'; end if;

  -- phone binding: anonymous claim forbidden, admin binds, phone issue works, unknown phone rejected
  perform set_config('request.jwt.claim.sub', other::text, true);
  begin perform invite_stage.bind_phone(cust, '+15550001111');
    raise exception 'TEST bind forbidden';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
  perform set_config('request.jwt.claim.sub', jake::text, true);
  perform invite_stage.bind_phone(cust, '+15550001111');
  j = public.invite_issue_by_phone('+15550001111', 'buddy@example.invalid', 'phone-1', now()+interval '7 days');
  if j->>'token' is null then raise exception 'TEST phone issue'; end if;
  begin perform public.invite_issue_by_phone('+15559999999','b@example.invalid','phone-2',now()+interval '7 days');
    raise exception 'TEST unknown phone';
  exception when others then if sqlerrm<>'unknown customer phone' then raise; end if; end;

  -- peek: valid token visible without consuming, unknown token not
  j = public.invite_peek(tok);
  if (j->>'valid')::boolean is not true or j->>'intended_email'<>'wrap@example.invalid' then raise exception 'TEST peek valid'; end if;
  if (public.invite_peek('deadbeef')->>'valid')::boolean is not false then raise exception 'TEST peek unknown'; end if;

  -- redeem wrapper respects the activation gate first
  begin perform public.invite_redeem(recipient2, tok, 'X');
    raise exception 'TEST redeem gate';
  exception when others then if sqlerrm<>'activation disabled' then raise; end if; end;

  -- provisioning: forbidden for non-admin, explicit zero pricing + owner membership for admin
  update invite_stage.settings set activation_enabled=true;
  insert into auth.users(id,email,email_confirmed_at) values(recipient2,'prov@example.invalid',now());
  j = public.invite_issue(jake, cust, 'prov@example.invalid', 'prov-1', now()+interval '7 days');
  bid = public.invite_redeem(recipient2, j->>'token', 'Prov Co');
  perform set_config('request.jwt.claim.sub', other::text, true);
  begin perform invite_stage.provision_business((j->>'id')::uuid);
    raise exception 'TEST prov forbidden';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
  perform set_config('request.jwt.claim.sub', jake::text, true);
  pid = invite_stage.provision_business((j->>'id')::uuid);
  if (select plan_texts from public.businesses where id=pid) is distinct from 0
     or (select plan_price_cents from public.businesses where id=pid) is distinct from 0
     or (select overage_cents from public.businesses where id=pid) is distinct from 0
     or (select addon_user_cents from public.businesses where id=pid) is distinct from 0
  then raise exception 'TEST pricing defaults leaked'; end if;
  if (select role from public.business_members where business_id=pid and user_id=recipient2) is distinct from 'owner'
  then raise exception 'TEST membership'; end if;
end $$;
select 'PASS: wrappers pass actor through, allowance admin-only, phone binding admin-only, phone issue, peek, activation gate, zero-pricing provisioning, owner membership' as result;
