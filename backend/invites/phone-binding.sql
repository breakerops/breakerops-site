-- Phone binding for the Matt text flow: a customer texts Matt asking for an invite
-- link; the desk matches the sender's E.164 phone to exactly one customer. Binding is
-- admin-only (Jake's user id) so no customer can claim someone else's phone.
alter table invite_stage.customers
  add column if not exists phone text unique check (phone ~ '^\+[1-9]\d{7,14}$');

create or replace function invite_stage.bind_phone(p_customer uuid, p_phone text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then
    raise exception 'forbidden';
  end if;
  update invite_stage.customers set phone = p_phone where id = p_customer;
  if not found then raise exception 'unknown customer'; end if;
  insert into invite_stage.audit(event, actor) values('phone_bound', auth.uid());
end $$;

revoke all on function invite_stage.bind_phone(uuid, text) from public, anon, authenticated;
