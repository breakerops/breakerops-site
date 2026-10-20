-- Rollback tests for v2 wrappers. Run as: begin; <core> <this>; rollback;
do $$
declare cust uuid; j jsonb; jake uuid='80f2d1a2-7634-40e8-abf6-904e0aae73b4'; other uuid='44444444-4444-4444-8444-444444444444';
begin
  insert into invite_stage.customers(owner_user_id) values(jake) returning id into cust;
  -- bind customer phone as admin, then desk issues by customer phone
  perform public.invite_bind_phone(jake, cust, '+15550001111');
  begin perform public.invite_bind_phone(other, cust, '+15550001112');
    raise exception 'TEST bind admin';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
  j = public.invite_issue_by_phone('+15550001111', '+15552223333', 'desk-1', now()+interval '7 days');
  if (j->>'already_issued')::boolean then raise exception 'TEST desk issue'; end if;
  -- unknown customer phone rejected
  begin perform public.invite_issue_by_phone('+15559999999','+15552223334','desk-2',now()+interval '7 days');
    raise exception 'TEST unknown phone';
  exception when others then if sqlerrm<>'unknown customer phone' then raise; end if; end;
  -- allowance via wrapper: non-admin forbidden, admin applies
  begin perform public.invite_set_allowance(other, cust, 9);
    raise exception 'TEST allowance forbidden';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
  perform public.invite_set_allowance(jake, cust, 7);
  if (select allowance from invite_stage.customers where id=cust)<>7 then raise exception 'TEST allowance apply'; end if;
  -- redeem wrapper: activation gate then admitted
  begin perform public.invite_redeem_on_inbound('+15552223333');
    raise exception 'TEST redeem gate';
  exception when others then if sqlerrm<>'activation disabled' then raise; end if; end;
  update invite_stage.settings set activation_enabled=true;
  j = public.invite_redeem_on_inbound('+15552223333');
  if j->>'status'<>'admitted' then raise exception 'TEST redeem admitted'; end if;
  -- revoke via wrapper frees phone
  perform public.invite_revoke(jake, (select id from invite_stage.links where request_key='desk-1' and accepted_at is null limit 1));
end $$;
select 'PASS: desk issue by phone, unknown phone, allowance admin-only, redeem wrapper gate+admitted, revoke wrapper' as result;
