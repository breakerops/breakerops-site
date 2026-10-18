-- Scheduler: fires the sender every minute. Keys live in a private config table,
-- not in the cron definition. Apply after schema.sql and after deploying functions.

create schema if not exists private;
create table if not exists private.config (key text primary key, value text not null);
revoke all on private.config from public, anon, authenticated;

insert into private.config (key, value) values
  ('functions_base', 'https://euchkgnqxycqzgamucry.supabase.co/functions/v1')
on conflict (key) do nothing;
-- Set once by the operator, same value as the REMINDERS_KEY function secret:
-- Set once by the operator, same value as the REMINDERS_KEY function secret:
-- insert into private.config (key, value) values ('reminders_key', '<shared-key>')
-- on conflict (key) do update set value = excluded.value;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('reminders-send', '* * * * *', $cmd$
  select net.http_post(
    url := (select value from private.config where key = 'functions_base') || '/reminders-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select value from private.config where key = 'api_key'),
      'Authorization', 'Bearer ' || (select value from private.config where key = 'api_key'),
      'x-reminders-key', (select value from private.config where key = 'reminders_key')),
    body := '{}'::jsonb
  );
$cmd$);
