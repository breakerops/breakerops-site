-- sms-opt-outs.sql: STOP/START registry for the BreakerOps sending number.
-- The published SMS terms (breakerops.com/sms-terms) promise: "Reply STOP to
-- any message to stop all texts. You will get one final text confirming you
-- are unsubscribed." This table is the enforcement point; telnyx-inbound
-- maintains it and reminders-send honors it before every SMS send.
create table if not exists public.sms_opt_outs (
  phone text primary key,                    -- E.164, one sending number = one registry
  opted_out_at timestamptz not null default now(),
  keyword text not null default 'STOP',      -- the exact keyword received
  created_at timestamptz not null default now()
);
alter table public.sms_opt_outs enable row level security;
-- Service-role only: no policies = default deny for anon/authenticated.
-- START removes the row (delete), so "row exists" always means "opted out".
