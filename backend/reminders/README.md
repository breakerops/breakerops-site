# BreakerOps reminder engine

The product-owned reminder pipeline. A reminder is set and sent by the product with no person in the loop. The conversation model that talks to the customer is a swappable part; this directory is the part that is not swapped.

Living product doc (decisions, rules, benchmark): https://docs.google.com/document/d/1q-YwHmSN5uLr51VAizpsJvud3bwWv7YPggTPTdnlGt0/edit

## Pieces

- `schema.sql` — the `reminders` table (business-keyed, absolute `send_at`, per-business idempotency key, status state machine pending/claimed/sent/failed/uncertain/cancelled), the `model_providers` table (which conversation model is active; exactly one), RLS policies, and the `claim_due_reminders` / `cancel_reminder` functions. Applied in the Supabase SQL editor.
- `cron.sql` — private config table, pg_cron + pg_net setup, and the per-minute job that calls the sender. Secrets live in `private.config` and edge-function secrets, never in this repo.
- `functions/reminders-write.ts` — the product's write API, deployed as a Supabase edge function. Any conversation backend calls it with a shared key. Requires an absolute ISO timestamp, a recipient, a body, and an idempotency key; a repeated call returns the existing row instead of double-sending. Conversation rules (no guessing, no ambiguous times) are enforced here, not in the model.
- `functions/reminders-send.ts` — runs every minute via cron. Claims due reminders atomically (skip locked) and delivers through one channel interface: `log`, `email` (Resend), `sms` (Twilio). Unknown network outcomes become `uncertain` for review, never silent retries.

## Status

- Engine deployed and live-tested 2026-10-17: a log-channel reminder fired 19 seconds after its due time with no human involved.
- SMS channel needs a Twilio number (not provisioned; requires owner approval, costs money, A2P registration takes days).
- Email channel needs the Resend API key set as the `RESEND_API_KEY` function secret.
- Cron precision is per-minute, so sends land within about 60 seconds of the set time. Deliberate; a paid always-on worker would be needed for second precision.
