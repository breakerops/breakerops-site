-- deletion.sql: scoped business deletion per the service-desk runbook.
-- Three deliberate member-gated steps; never callable by anon/day-link.
--   deletion_preview      - scoped inventory counts BEFORE anything
--                           destructive (any member may preview)
--   business_deactivate   - containment: stop future processing first so no
--                           cron can resurrect reminders after deletion
--   business_delete       - dependency-ordered delete, refused unless
--                           containment already ran
-- Destructive steps require the OWNER role: a plain member of a multi-user
-- business must not be able to destroy it.
-- Retained by design (documented, NOT deleted here): sms_opt_outs (deleting a
-- suppression record would re-enable unwanted texts), usage_monthly
-- (financial record), inbound_events (provider event ledger, phone-scoped).
-- leads/signups are not business-scoped; identity-tied rows are a separate
-- desk decision. Backups, logs and provider copies are outside SQL scope and
-- need their own schedule before anyone says "everything deleted".

create or replace function public.deletion_preview(p_business uuid)
returns table(scope text, item_count bigint)
language plpgsql security definer set search_path='public' as $$
begin
  if not is_member(p_business) then raise exception 'forbidden'; end if;
  return query
    select 'brief_subscriptions'::text, count(*) from brief_subscriptions where business_id = p_business
    union all select 'calendar_items', count(*) from calendar_items where business_id = p_business
    union all select 'calendar_weekly_series', count(*) from calendar_weekly_series where business_id = p_business
    union all select 'daily_summaries', count(*) from daily_summaries where business_id = p_business
    union all select 'day_tokens', count(*) from day_tokens where business_id = p_business
    union all select 'info_notes', count(*) from info_notes where business_id = p_business
    union all select 'reminders', count(*) from reminders where business_id = p_business
    union all select 'thought_feedback', count(*) from thought_feedback where business_id = p_business
    union all select 'business_thoughts', count(*) from business_thoughts where business_id = p_business
    union all select 'user_invites', count(*) from user_invites where business_id = p_business
    union all select 'business_members', count(*) from business_members where business_id = p_business
    union all select 'push_subscriptions', count(*) from push_subscriptions
      where user_id in (select user_id from business_members where business_id = p_business)
    union all select 'RETAINED usage_monthly (financial record)', count(*) from usage_monthly where business_id = p_business;
end $$;

create or replace function public.business_deactivate(p_business uuid)
returns jsonb language plpgsql security definer set search_path='public' as $$
declare
  n_briefs int; n_tokens int; n_push int; n_items int; n_series int; n_rem int;
begin
  if not exists (select 1 from business_members
                 where business_id = p_business and user_id = auth.uid() and role = 'owner') then
    raise exception 'owner role required';
  end if;
  -- stop future brief enqueue
  update brief_subscriptions set active = false where business_id = p_business and active;
  get diagnostics n_briefs = row_count;
  -- invalidate customer access (the day token IS the customer login)
  delete from day_tokens where business_id = p_business;
  get diagnostics n_tokens = row_count;
  -- drop push subscriptions of users whose ONLY membership is this business
  -- (a multi-business member's devices must not be touched)
  delete from push_subscriptions where user_id in (
    select user_id from business_members bm
    where bm.business_id = p_business
      and not exists (select 1 from business_members m2
                      where m2.user_id = bm.user_id and m2.business_id <> p_business));
  get diagnostics n_push = row_count;
  -- stop event-reminder and weekly-series enqueue sources
  delete from calendar_items where business_id = p_business;
  get diagnostics n_items = row_count;
  delete from calendar_weekly_series where business_id = p_business;
  get diagnostics n_series = row_count;
  -- cancel everything not yet sent so reminders-send never picks it up
  update reminders set status = 'cancelled'
    where business_id = p_business and status in ('pending','claimed','accepted');
  get diagnostics n_rem = row_count;
  return jsonb_build_object(
    'briefs_deactivated', n_briefs, 'day_tokens_removed', n_tokens,
    'push_subscriptions_removed', n_push, 'calendar_items_removed', n_items,
    'weekly_series_removed', n_series, 'reminders_cancelled', n_rem);
end $$;

create or replace function public.business_delete(p_business uuid)
returns jsonb language plpgsql security definer set search_path='public' as $$
declare
  n_rem int; n_tf int; n_bt int; n_ds int; n_in int; n_ui int; n_bs int; n_bm int; n_b int;
begin
  if not exists (select 1 from business_members
                 where business_id = p_business and user_id = auth.uid() and role = 'owner') then
    raise exception 'owner role required';
  end if;
  -- refuse unless containment already ran: no live enqueue source or access
  -- path may remain, otherwise crons would resurrect work after the delete.
  if exists (select 1 from brief_subscriptions where business_id = p_business and active)
     or exists (select 1 from day_tokens where business_id = p_business)
     or exists (select 1 from calendar_items where business_id = p_business)
     or exists (select 1 from calendar_weekly_series where business_id = p_business) then
    raise exception 'deactivate first';
  end if;
  delete from reminders where business_id = p_business;            get diagnostics n_rem = row_count;
  delete from thought_feedback where business_id = p_business;     get diagnostics n_tf = row_count;
  delete from business_thoughts where business_id = p_business;    get diagnostics n_bt = row_count;
  delete from daily_summaries where business_id = p_business;      get diagnostics n_ds = row_count;
  delete from info_notes where business_id = p_business;           get diagnostics n_in = row_count;
  delete from user_invites where business_id = p_business;         get diagnostics n_ui = row_count;
  delete from brief_subscriptions where business_id = p_business;  get diagnostics n_bs = row_count;
  delete from business_members where business_id = p_business;     get diagnostics n_bm = row_count;
  delete from businesses where id = p_business;                    get diagnostics n_b = row_count;
  return jsonb_build_object(
    'reminders', n_rem, 'thought_feedback', n_tf, 'business_thoughts', n_bt,
    'daily_summaries', n_ds, 'info_notes', n_in, 'user_invites', n_ui,
    'brief_subscriptions', n_bs, 'business_members', n_bm, 'businesses', n_b);
end $$;

revoke all on function public.deletion_preview(uuid) from public, anon;
revoke all on function public.business_deactivate(uuid) from public, anon;
revoke all on function public.business_delete(uuid) from public, anon;
grant execute on function public.deletion_preview(uuid) to authenticated;
grant execute on function public.business_deactivate(uuid) to authenticated;
grant execute on function public.business_delete(uuid) to authenticated;
