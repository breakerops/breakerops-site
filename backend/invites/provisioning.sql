-- Production provisioning of a referral-admitted business. NOT TO RUN until Jake
-- settles plan terms for referred businesses. Writes explicit zero pricing so the
-- paid-plan column defaults (3000 texts / $80 plan) can never silently apply to a
-- business whose owner never consented to a plan; a zero row cannot accrue charges.
-- Desk/admin initiated only; the invite must already be accepted.
create or replace function invite_stage.provision_business(p_link uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare l invite_stage.links; b invite_stage.businesses; new_id uuid;
begin
  if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then
    raise exception 'forbidden';
  end if;
  select * into l from invite_stage.links where id = p_link and accepted_at is not null;
  if not found then raise exception 'invite not accepted'; end if;
  select * into b from invite_stage.businesses where id = l.accepted_business_id;
  insert into public.businesses(id, name, plan_texts, overage_cents, plan_price_cents, addon_user_cents)
  values (b.id, b.name, 0, 0, 0, 0)
  returning id into new_id;
  insert into public.business_members(business_id, user_id, role)
  values (new_id, b.owner_user_id, 'owner');
  insert into invite_stage.audit(event, actor, link_id) values('provisioned', auth.uid(), p_link);
  return new_id;
end $$;

revoke all on function invite_stage.provision_business(uuid) from public, anon, authenticated;
