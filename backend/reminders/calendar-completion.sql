revoke all on function public.set_calendar_completion(uuid,boolean) from authenticated;
create or replace function public.set_calendar_completion(p_id uuid,p_completed boolean) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 if current_setting('role',true) <> 'service_role' then raise exception 'Backend access required'; end if;
 update calendar_items set completed=p_completed where id=p_id;
 if not found then raise exception 'Calendar item not found'; end if;
 return p_completed;
end $$;
grant execute on function public.set_calendar_completion(uuid,boolean) to service_role;
