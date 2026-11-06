-- Security fix 2026-11-06: is_admin() returned NULL for anonymous callers, so
-- "if not is_admin() then raise" gates never fired and admin RPCs answered anon.
-- 1) is_admin() now returns false, never NULL.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path to 'public'
as $$ select coalesce(auth.uid() = '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid, false) $$;

-- 2) Remove default PUBLIC/anon execute on admin RPCs; keep Jake's logged-in
-- admin session (authenticated) and edge functions (service_role).
revoke all on function public.signups_list() from public, anon;
revoke all on function public.page_views_summary(integer) from public, anon;
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.connection_status() from public, anon;
revoke all on function public.active_model() from public, anon;
revoke all on function public.admin_day_link() from public, anon;

grant execute on function public.signups_list() to authenticated, service_role;
grant execute on function public.page_views_summary(integer) to authenticated, service_role;
grant execute on function public.admin_overview() to authenticated, service_role;
grant execute on function public.connection_status() to authenticated, service_role;
grant execute on function public.active_model() to authenticated, service_role;
grant execute on function public.admin_day_link() to authenticated, service_role;
