-- Anonymous site visit counter (approved 2026-11-06). No cookies, no banner,
-- no raw IP: stores date, page, referrer, and a daily-rotating HMAC visitor
-- hash so uniques can be counted per day without keeping any IP.
create table if not exists page_views (
  id uuid primary key default gen_random_uuid(),
  viewed_on date not null,
  page text not null,
  referrer text,
  visitor_hash text,
  created_at timestamptz not null default now()
);
alter table page_views enable row level security;
grant all on page_views to service_role;

create or replace function page_views_summary(days_back int default 14) returns json language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'not allowed'; end if;
  return (select json_build_object(
    'daily', (select coalesce(json_agg(d order by d.day), '[]'::json) from (
      select viewed_on as day, count(*) as visits, count(distinct visitor_hash) as uniques
      from public.page_views
      where viewed_on >= current_date - greatest(days_back, 1)
      group by viewed_on) d),
    'top_pages', (select coalesce(json_agg(p order by p.visits desc), '[]'::json) from (
      select page, count(*) as visits, count(distinct visitor_hash) as uniques
      from public.page_views
      where viewed_on >= current_date - greatest(days_back, 1)
      group by page order by count(*) desc limit 10) p)
  ));
end $$;
