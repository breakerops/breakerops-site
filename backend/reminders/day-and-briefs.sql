-- BreakerOps day page, daily briefs, and usage billing.
-- Applied 2026-10-18 via the Supabase SQL editor. Kept here for reference and rebuilds.

-- Day page data: items get an optional time and an idempotency key for mirrors.
alter table calendar_items add column if not exists due_time time;
alter table calendar_items add column if not exists external_key text;
create unique index if not exists calendar_items_biz_extkey
  on calendar_items (business_id, external_key) where external_key is not null;

-- One stable day link per business. The token in the URL is the login.
create table if not exists day_tokens (
  business_id uuid primary key references businesses(id),
  token text unique not null,
  created_at timestamptz default now()
);
alter table day_tokens enable row level security;

-- Daily brief subscriptions: who gets the morning text, when, in which timezone.
create table if not exists brief_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  recipient_channel text not null,
  recipient text not null,
  send_time time not null,
  tz text not null default 'America/Chicago',
  active boolean not null default true,
  created_by text default 'conversation',
  created_at timestamptz default now()
);
alter table brief_subscriptions enable row level security;

-- Token -> business resolution, used by the day-link read policies.
create or replace function business_for_token(tok text) returns uuid
  language sql security definer stable as
$$ select business_id from day_tokens where token = tok $$;

-- Day page reads via PostgREST with an x-day-token header (anon role).
create policy day_link_read on calendar_items for select to anon
  using (business_id = business_for_token(current_setting('request.headers',true)::json->>'x-day-token'));
create policy day_link_biz on businesses for select to anon
  using (id = business_for_token(current_setting('request.headers',true)::json->>'x-day-token'));
-- Mirror/insert path: writes need the service key as x-reminders-key.
create policy day_items_svc_write on calendar_items for insert to anon
  with check ((select value from private.config where key='reminders_key')
    = current_setting('request.headers',true)::json->>'x-reminders-key');
grant select on calendar_items to anon;
grant select on businesses to anon;
grant insert on calendar_items to anon;

-- Brief enqueue: subscriptions whose local time is now, one reminder per day.
create or replace view v_due_briefs as
select s.business_id, s.recipient_channel, s.recipient,
       'Today:' || E'\n' || 'https://www.breakerops.com/day/?t=' || t.token as body,
       s.id as sid, s.tz
from brief_subscriptions s
join day_tokens t on t.business_id = s.business_id
where s.active
  and to_char(now() at time zone s.tz,'HH24:MI') = to_char(s.send_time,'HH24:MI');

select cron.schedule('briefs-enqueue','* * * * *', $$insert into reminders
  (business_id,recipient_channel,recipient,body,send_at,idempotency_key,created_by)
  select business_id,recipient_channel,recipient,body,now(),
         'brief:'||sid||':'||to_char(now() at time zone tz,'YYYY-MM-DD'),'brief-engine'
  from v_due_briefs on conflict (business_id,idempotency_key) do nothing$$);

-- Plan and usage: $80/mo includes 3,000 texts account-wide; overage $0.03/text.
alter table businesses add column if not exists plan_texts int default 3000;
alter table businesses add column if not exists overage_cents int default 3;
alter table businesses add column if not exists plan_price_cents int default 8000;
alter table businesses add column if not exists addon_user_cents int default 2000;

create table if not exists usage_monthly (
  business_id uuid references businesses(id),
  month date not null,
  texts int not null default 0,
  primary key (business_id, month)
);
alter table usage_monthly enable row level security;

-- Count only real SMS sends (log-channel sends do not count).
create or replace function count_sent_text() returns trigger language plpgsql as $$
begin
  if NEW.status='sent' and OLD.status is distinct from 'sent' and NEW.recipient_channel in ('sms') then
    insert into usage_monthly (business_id, month, texts)
    values (NEW.business_id, date_trunc('month', NEW.sent_at)::date, 1)
    on conflict (business_id, month) do update set texts = usage_monthly.texts + 1;
  end if;
  return NEW;
end $$;

create trigger reminders_count_text after update on reminders
  for each row execute function count_sent_text();

-- Billing view: usage vs plan, overage in texts and cents.
create or replace view v_usage_billing as
select b.id as business_id, u.month, u.texts, b.plan_texts,
       greatest(u.texts - b.plan_texts, 0) as overage_texts,
       greatest(u.texts - b.plan_texts, 0) * b.overage_cents as overage_cents
from usage_monthly u join businesses b on b.id = u.business_id;
