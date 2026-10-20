-- Event reminders for the owner's own calendar: one desk email per timed
-- calendar item about 15 minutes before it starts, carrying the BreakerOps
-- calendar link. Instinct relays that email to Jake as a text. The product
-- SMS channel stays untouched until Telnyx is live. Applied 2026-10-20.
--
-- Delivery path: this cron inserts a log-channel row (dedupe + audit) and,
-- only for newly inserted rows, posts the same desk notification the signup
-- function uses (formsubmit -> nick@breakerops.com, lands in the watched
-- mailbox). Chosen because the Resend key for the email channel is not
-- configured yet; swap to channel 'email' once it is.

drop view if exists v_due_event_reminders;
create view v_due_event_reminders as
select i.business_id,
       i.id as item_id,
       to_char(i.due_date + i.due_time, 'HH12:MI AM') || ' ' || i.title
         || E'\n' || 'https://www.breakerops.com/app/' as body
from calendar_items i
where i.due_time is not null
  and coalesce(i.completed, false) = false
  and i.due_date = (now() at time zone 'America/Chicago')::date
  and (i.due_date + i.due_time)
        between (now() at time zone 'America/Chicago') + interval '11 minutes'
            and (now() at time zone 'America/Chicago') + interval '21 minutes';

select cron.unschedule('event-reminders-enqueue') where exists
  (select 1 from cron.job where jobname = 'event-reminders-enqueue');

select cron.schedule('event-reminders-enqueue', '*/5 * * * *', $cmd$
  with new_rows as (
    insert into reminders
      (business_id, recipient_channel, recipient, body, send_at, idempotency_key, created_by)
    select business_id, 'log', 'event-relay', body, now(),
           'event:' || item_id::text, 'event-engine'
    from v_due_event_reminders
    on conflict (business_id, idempotency_key) do nothing
    returning body
  )
  select net.http_post(
    url := 'https://formsubmit.co/ajax/nick@breakerops.com',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Accept', 'application/json',
                                  'Referer', 'https://www.breakerops.com/app/'),
    body := jsonb_build_object('_subject', 'BreakerOps reminder',
                               'message', body,
                               '_template', 'table'))
  from new_rows
$cmd$);
