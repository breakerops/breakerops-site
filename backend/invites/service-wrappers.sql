-- Public wrappers, callable ONLY by service_role. Edge Functions verify the caller
-- (user JWT, or desk shared secret for the Matt text flow) and pass the verified
-- actor; the wrapper sets the per-transaction claim the staged core checks.
-- Never grant these to anon or authenticated.

create or replace function public.invite_issue(p_actor uuid, p_customer uuid, p_email text, p_request_key text, p_expires timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  return invite_stage.issue(p_customer, p_email, p_request_key, p_expires);
end $$;

create or replace function public.invite_issue_by_phone(p_phone text, p_email text, p_request_key text, p_expires timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c invite_stage.customers;
begin
  select * into c from invite_stage.customers where phone = p_phone and active;
  if not found then raise exception 'unknown customer phone'; end if;
  perform set_config('request.jwt.claim.sub', c.owner_user_id::text, true);
  return invite_stage.issue(c.id, p_email, p_request_key, p_expires);
end $$;

create or replace function public.invite_redeem(p_actor uuid, p_token text, p_business_name text)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  return invite_stage.redeem(p_token, p_business_name);
end $$;

create or replace function public.invite_revoke(p_actor uuid, p_link uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform invite_stage.revoke(p_link);
end $$;

create or replace function public.invite_set_allowance(p_actor uuid, p_customer uuid, p_amount integer)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform invite_stage.set_allowance(p_customer, p_amount);
end $$;

-- Read-only token peek for the email-challenge step: validates without consuming.
create or replace function public.invite_peek(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l invite_stage.links;
begin
  select * into l from invite_stage.links
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found then return jsonb_build_object('valid', false, 'reason', 'unknown'); end if;
  if l.accepted_at is not null then return jsonb_build_object('valid', false, 'reason', 'accepted'); end if;
  if l.revoked_at is not null then return jsonb_build_object('valid', false, 'reason', 'revoked'); end if;
  if l.expires_at <= now() then return jsonb_build_object('valid', false, 'reason', 'expired'); end if;
  return jsonb_build_object('valid', true, 'intended_email', l.intended_email, 'expires_at', l.expires_at);
end $$;

revoke all on function public.invite_issue(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.invite_issue_by_phone(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.invite_redeem(uuid, text, text) from public, anon, authenticated;
revoke all on function public.invite_revoke(uuid, uuid) from public, anon, authenticated;
revoke all on function public.invite_set_allowance(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.invite_peek(text) from public, anon, authenticated;
grant execute on function public.invite_issue(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.invite_issue_by_phone(text, text, text, timestamptz) to service_role;
grant execute on function public.invite_redeem(uuid, text, text) to service_role;
grant execute on function public.invite_revoke(uuid, uuid) to service_role;
grant execute on function public.invite_set_allowance(uuid, uuid, integer) to service_role;
grant execute on function public.invite_peek(text) to service_role;
