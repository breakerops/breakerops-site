-- Public wrappers v2, callable ONLY by service_role. Text-first model: customers
-- never authenticate; the desk (Matt conversation) verifies the sender's phone and
-- calls these. The inbound SMS handler calls invite_redeem_on_inbound directly.
-- Never grant these to anon or authenticated.
--
-- TRUST SCOPE: p_actor is a TRUSTED-SERVICE INPUT, not user-auth proof. Only
-- service_role can execute these; the value is asserted by the calling
-- backend (the desk), never by the requester. Do not widen grants.
-- IDENTITY HYGIENE: wrappers that impersonate (set request.jwt.claim.sub for
-- the core functions' auth checks) preserve the caller's prior claim and
-- restore it on BOTH success and exception, so identity never bleeds into
-- the rest of the caller's transaction.

-- Desk path: customer texts Matt asking to invite a buddy. The desk passes the
-- customer's verified texting phone; the wrapper finds their customer row and issues
-- the invitation bound to the buddy's phone. No token is created or returned.
create or replace function public.invite_issue_by_phone(p_customer_phone text, p_buddy_phone text, p_request_key text, p_expires timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c invite_stage.customers; prior text; r jsonb;
begin
  prior := current_setting('request.jwt.claim.sub', true);
  select * into c from invite_stage.customers where phone = p_customer_phone and active;
  if not found then raise exception 'unknown customer phone'; end if;
  perform set_config('request.jwt.claim.sub', c.owner_user_id::text, true);
  r := invite_stage.issue(c.id, p_buddy_phone, p_request_key, p_expires);
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
  return r;
exception when others then
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
  raise;
end $$;

-- Inbound handler path: a text arrived from this phone. Admits if a valid invite
-- exists, recognizes existing admitted phones, returns 'none' for public leads.
create or replace function public.invite_redeem_on_inbound(p_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return invite_stage.redeem_on_inbound(p_phone);
end $$;

-- Desk/admin: revoke an unused invitation by id (frees the slot and the phone).
create or replace function public.invite_revoke(p_actor uuid, p_link uuid)
returns void language plpgsql security definer set search_path='' as $$
declare prior text;
begin
  prior := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform invite_stage.revoke(p_link);
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
exception when others then
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
  raise;
end $$;

-- Admin (Jake): set a customer's allowance.
create or replace function public.invite_set_allowance(p_actor uuid, p_customer uuid, p_amount integer)
returns void language plpgsql security definer set search_path='' as $$
declare prior text;
begin
  prior := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform invite_stage.set_allowance(p_customer, p_amount);
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
exception when others then
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
  raise;
end $$;

-- Admin (Jake): bind a customer's texting phone.
create or replace function public.invite_bind_phone(p_actor uuid, p_customer uuid, p_phone text)
returns void language plpgsql security definer set search_path='' as $$
declare prior text;
begin
  prior := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform invite_stage.bind_phone(p_customer, p_phone);
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
exception when others then
  perform set_config('request.jwt.claim.sub', coalesce(prior,''), true);
  raise;
end $$;

revoke all on function public.invite_issue_by_phone(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.invite_redeem_on_inbound(text) from public, anon, authenticated;
revoke all on function public.invite_revoke(uuid, uuid) from public, anon, authenticated;
revoke all on function public.invite_set_allowance(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.invite_bind_phone(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.invite_issue_by_phone(text, text, text, timestamptz) to service_role;
grant execute on function public.invite_redeem_on_inbound(text) to service_role;
grant execute on function public.invite_revoke(uuid, uuid) to service_role;
grant execute on function public.invite_set_allowance(uuid, uuid, integer) to service_role;
grant execute on function public.invite_bind_phone(uuid, uuid, text) to service_role;
