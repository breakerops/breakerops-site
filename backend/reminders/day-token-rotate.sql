-- day-token-rotate.sql: intentional rotation of a business's day-link token.
-- Recovery path for a leaked/lost day link. The token IS the customer login
-- (see day-and-briefs.sql), so there is no silent expiry; rotation is an
-- explicit, member-initiated act. Existing access is preserved until someone
-- intentionally rotates. After rotation the old token immediately stops
-- resolving (business_for_token finds only the new one); the next daily brief
-- automatically texts the new link because v_due_briefs reads day_tokens,
-- so legitimate customers self-heal within a day and the desk can re-send
-- sooner by triggering a brief or texting the link.
create or replace function public.rotate_day_token(p_business uuid)
returns text language plpgsql security definer set search_path='public' as $$
declare new_tok text;
begin
  if not is_member(p_business) then
    raise exception 'forbidden';
  end if;
  new_tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into day_tokens (business_id, token)
  values (p_business, new_tok)
  on conflict (business_id) do update set token = excluded.token, created_at = now();
  return new_tok;
end $$;
-- Members (authenticated app users) only; never callable by anon/day-link role.
revoke all on function public.rotate_day_token(uuid) from public, anon;
grant execute on function public.rotate_day_token(uuid) to authenticated;
