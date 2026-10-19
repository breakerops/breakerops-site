# BreakerOps reminder engine

The product-owned reminder pipeline. A reminder is set and sent by the product with no person in the loop. The conversation model that talks to the customer is a swappable part; this directory is the part that is not swapped.

Living product doc (decisions, rules, benchmark): https://docs.google.com/document/d/1q-YwHmSN5uLr51VAizpsJvud3bwWv7YPggTPTdnlGt0/edit

## Pieces

- `schema.sql` — the `reminders` table (business-keyed, absolute `send_at`, per-business idempotency key, status state machine pending/claimed/sent/failed/uncertain/cancelled), the `model_providers` table (which conversation model is active; exactly one), RLS policies, and the `claim_due_reminders` / `cancel_reminder` functions. Applied in the Supabase SQL editor.
- `cron.sql` — private config table, pg_cron + pg_net setup, and the per-minute job that calls the sender. Secrets live in `private.config` and edge-function secrets, never in this repo.
- `functions/reminders-write.ts` — the product's write API, deployed as a Supabase edge function. Any conversation backend calls it with a shared key. Requires an absolute ISO timestamp, a recipient, a body, and an idempotency key; a repeated call returns the existing row instead of double-sending. Conversation rules (no guessing, no ambiguous times) are enforced here, not in the model.
- `functions/reminders-send.ts` — runs every minute via cron. Claims due reminders atomically (skip locked) and delivers through one channel interface: `log`, `email` (Resend), `sms` (Telnyx). Unknown network outcomes become `uncertain` for review, never silent retries.

## Status

- Engine deployed and live-tested 2026-10-17: a log-channel reminder fired 19 seconds after its due time with no human involved.
- SMS channel sends through Telnyx. The API key, sending number, and 10DLC messaging profile are entered by the owner at breakerops.com/admin and stored server-side in private.connections; with none saved, sms sends fail cleanly as "sms provider not configured". Requires the owner's Telnyx account, number, and approved 10DLC campaign (owner action, costs money).
- Email channel needs the Resend API key set as the `RESEND_API_KEY` function secret.
- Cron precision is per-minute, so sends land within about 60 seconds of the set time. Deliberate; a paid always-on worker would be needed for second precision.

## Model adapter (Oct 18, 2026)

- `functions/model-complete.ts` — one endpoint for product-side text generation. The active provider is data (the `model_providers.active` row), not code. `manual` (instinct) returns 409 so callers keep the concierge path; `openai_compatible` posts to `{endpoint}/chat/completions` with the key saved in private.connections under the provider's name. Secured with the shared x-reminders-key.
- The owner picks the provider and saves keys at breakerops.com/admin (set_active_model / set_connection, owner-uid gated).
- `admin.sql` — the /admin page backend: private.connections (keys + non-secret meta), owner-gated set/status/overview functions, and the shared-key-gated server reads the edge functions use.
