-- push_subscriptions: one row per (user_id, endpoint) instead of one per endpoint,
-- so multiple accounts can receive push notifications on the same device.
-- The old unique(endpoint) made a second account's enable collide with the first.
-- push-send/reminders-push already select rows by user_id, so each account's
-- reminders deliver independently. Applied 2026-11-10 (pending deploy).
-- ROLLBACK: re-adding unique(endpoint) fails while any endpoint has rows for more
-- than one user; first delete duplicate-endpoint rows keeping one user per endpoint,
-- then: alter table public.push_subscriptions drop constraint push_subscriptions_user_endpoint_key,
-- add constraint push_subscriptions_endpoint_key unique (endpoint);
begin;
alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_key;
alter table public.push_subscriptions add constraint push_subscriptions_user_endpoint_key unique (user_id, endpoint);
commit;
