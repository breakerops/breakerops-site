-- Event reminders for the owner's own calendar: one email per timed calendar
-- item, 30 minutes before it starts, carrying the BreakerOps calendar link.
-- The desk email is relayed to Jake as a text by Instinct; the product SMS
-- channel stays untouched until Telnyx is live. Applied 2026-10-20.

create or replace view v_due_event_reminders as
select i.business_id,
       i.id as item_id,
       to_char(i.due_date + i.due_time, 'HH12:MI AM') || ' ' || i.title
         || E'\n' || 'https://www.breakerops.com/app/' as body,
       ((i.due_date + i.due_time) - interval '30 minutes') at time zone 'America/Chicago' as send_at
from calendar_items i
where i.due_time is not null
  and coalesce(i.completed, false) = false
  and i.due_date = (now() at time zone 'America/Chicago')::date
  and (i.due_date + i.due_time)
        between (now() at time zone 'America/Chicago') + interval '20 minutes'
            and (now() at time zone 'America/Chicago') + interval '3 hours';

select cron.schedule('event-reminders-enqueue', '*/5 * * * *', $cmd$
  insert into reminders
    (business_id, recipient_channel, recipient, body, send_at, idempotency_key, created_by)
  select business_id, 'email', 'jake@breakerops.com', body, send_at,
         'event:' || item_id::text, 'event-engine'
  from v_due_event_reminders
  on conflict (business_id, idempotency_key) do nothing
$cmd$);
