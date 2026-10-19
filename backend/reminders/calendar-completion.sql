alter table public.calendar_items add column if not exists completed boolean not null default false;
create or replace function public.set_calendar_completion(p_id uuid,p_completed boolean) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 update calendar_items set completed=p_completed where id=p_id and is_member(business_id);
 if not found then raise exception 'Calendar item not found or not permitted'; end if;
 return p_completed;
end $$;
revoke all on function public.set_calendar_completion(uuid,boolean) from public,anon;
grant execute on function public.set_calendar_completion(uuid,boolean) to authenticated;
