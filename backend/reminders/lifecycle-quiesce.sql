-- lifecycle-quiesce.sql: dispatcher + producer admission checks for the
-- business lifecycle flag (Matt's quiesce design, 2026-10-23).
-- A quiescing business gets NO new send intents and NO new enqueued work;
-- already-admitted network work is preserved as evidence, never relabelled.
-- The flag itself was added by deletion.sql (businesses.lifecycle).

-- The claim RPC now reads businesses.lifecycle; the edge function's service
-- role needs SELECT on businesses (FOR UPDATE OF r keeps the lock reminders-only).
grant select on public.businesses to service_role;

-- Dispatcher admission: claim only reminders for ACTIVE businesses. Quiesce
-- blocks new intents at the atomic claim, the same transaction that owns them.
create or replace function public.claim_due_reminders(batch_size integer default 25)
returns setof public.reminders language sql as $$
  update public.reminders
     set status = 'claimed', attempts = attempts + 1
   where id in (
     select r.id from public.reminders r
      join public.businesses b on b.id = r.business_id
      where r.status = 'pending' and r.send_at <= now()
        and b.lifecycle = 'active'
      order by r.send_at
      limit batch_size
      for update of r skip locked  -- lock only reminders; joining businesses must not demand its UPDATE privilege
   )
  returning *;
$$;

-- Producer admission: brief enqueue only for active businesses.
create or replace view v_due_briefs as
select s.business_id, s.recipient_channel, s.recipient,
       'Today:' || E'\n' || 'https://www.breakerops.com/day/?t=' || t.token || '&v=2' as body,
       s.id as sid, s.tz
from brief_subscriptions s
join day_tokens t on t.business_id = s.business_id
join businesses b on b.id = s.business_id
where s.active and b.lifecycle = 'active'
  and to_char(now() at time zone s.tz,'HH24:MI') = to_char(s.send_time,'HH24:MI');

-- Producer admission: event-reminder enqueue only for active businesses.
create or replace view v_due_event_reminders as
select i.business_id,
       i.id as item_id,
       i.due_date + i.due_time as due_dt,
       to_char(i.due_date + i.due_time, 'HH12:MI AM') || ' ' || i.title
         || E'\n' || 'https://www.breakerops.com/app/' as body
from calendar_items i
join businesses b on b.id = i.business_id
where b.lifecycle = 'active'
  and i.due_time is not null
  and coalesce(i.completed, false) = false
  and i.due_date = (now() at time zone 'America/Chicago')::date
  and (i.due_date + i.due_time)
        between (now() at time zone 'America/Chicago') + interval '11 minutes'
            and (now() at time zone 'America/Chicago') + interval '21 minutes';
