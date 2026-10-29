-- life-log preserve-link support (applied 2026-10-29 via dashboard SQL editor;
-- recorded here because the SQL editor does not inherit dashboard default privileges)
grant select on public.daily_summaries to service_role;
