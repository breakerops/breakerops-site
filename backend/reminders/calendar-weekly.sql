create table if not exists public.calendar_weekly_series (
 id text primary key, user_id uuid not null, business_id uuid not null, title text not null,
 anchor_date date not null, due_time time, notes text not null);
alter table public.calendar_weekly_series enable row level security;
revoke all on public.calendar_weekly_series from anon, authenticated;
insert into public.calendar_weekly_series values ('665ur5il9fdrvdcn2jrr0dom1k','80f2d1a2-7634-40e8-abf6-904e0aae73b4','c91e6dbc-7cba-479d-8c8d-ea2ffd84967e','BreakerOps Friday scorecard','2026-10-23','07:00:00','Weekly one-glance BreakerOps numbers from Instinct (right after the 7 AM daily check).
Repeats weekly. Ends at 07:30 CT. Source: https://www.google.com/calendar/event?eid=NjY1dXI1aWw5ZmRydmRjbjJqcnIwZG9tMWtfMjAyNjEwMjNUMTIwMDAwWiBtb3JlanVpY2VsbGNAbQ&authuser=morejuicellc%40gmail.com') on conflict (id) do nothing;
insert into public.calendar_weekly_series values ('5h2ee9t3baaca676mcqosbq2n0','80f2d1a2-7634-40e8-abf6-904e0aae73b4','c91e6dbc-7cba-479d-8c8d-ea2ffd84967e','More Juice - LinkedIn Post','2026-08-10',NULL,'
Repeats weekly. Source: https://www.google.com/calendar/event?eid=NWgyZWU5dDNiYWFjYTY3Nm1jcW9zYnEybjBfMjAyNjA4MTAgMGI0YTY3ZDdjMWFhZGVjMTZmZWU4MDM3NjJmM2U4YWE5ZjQxYWFlYTIzNmUyMjNiYmFlMjUxMDdkOWIxZjQ2MUBn&authuser=morejuicellc%40gmail.com') on conflict (id) do nothing;
insert into public.calendar_weekly_series values ('lp24b4vur7qe15vl45gkk1bomg','80f2d1a2-7634-40e8-abf6-904e0aae73b4','c91e6dbc-7cba-479d-8c8d-ea2ffd84967e','More Juice - Team Meeting','2026-06-01','18:30:00','
Repeats weekly. Ends at 19:00 CT. Join: https://meet.google.com/pgh-nseg-imn
Source: https://www.google.com/calendar/event?eid=bHAyNGI0dnVyN3FlMTV2bDQ1Z2trMWJvbWdfMjAyNjA2MDFUMjMzMDAwWiAwYjRhNjdkN2MxYWFkZWMxNmZlZTgwMzc2MmYzZThhYTlmNDFhYWVhMjM2ZTIyM2JiYWUyNTEwN2Q5YjFmNDYxQGc&authuser=morejuicellc%40gmail.com') on conflict (id) do nothing;
create or replace function public.materialize_calendar_weekly_series() returns void language sql security definer set search_path=public as $$
insert into calendar_items(user_id,business_id,title,due_date,due_time,notes,external_key)
select s.user_id,s.business_id,s.title,d::date,s.due_time,s.notes,'weekly:'||s.id||':'||d::date
from calendar_weekly_series s cross join lateral generate_series(
 greatest(s.anchor_date,((now() at time zone 'America/Chicago')::date-1)),
 ((now() at time zone 'America/Chicago')::date+ interval '2 years')::date,interval '1 day') d
where extract(isodow from d)=extract(isodow from s.anchor_date)
and not exists(select 1 from calendar_items c where c.business_id=s.business_id and c.title=s.title and c.due_date=d::date)
on conflict (business_id,external_key) where external_key is not null do nothing;
$$;
revoke all on function public.materialize_calendar_weekly_series() from public, anon, authenticated;
select public.materialize_calendar_weekly_series();
select cron.schedule('breakerops-weekly-calendar-materialize','17 11 * * *','select public.materialize_calendar_weekly_series()');
