-- Messages: the in-app Matt chat. One row per message; business-scoped so every
-- member of the business shares the thread, and full history stays queryable.
-- direction: 'in' = customer -> Matt, 'out' = Matt -> customer.
-- Customer writes go through the messages_member_write policy (chat-send calls
-- with the user's JWT, so is_member stays enforced in the database); 'out'
-- replies are service-role only (chat-reply function).
-- Note: the account-deletion path (deletion.sql) does not yet cover this table;
-- add it when that path is next touched. Idempotent; safe to re-run.
-- PENDING DEPLOY - not yet applied.
begin;
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  user_id uuid not null,
  direction text not null check (direction in ('in','out')),
  body text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists messages_business_created on public.messages (business_id, created_at);
alter table public.messages enable row level security;
grant select, insert on public.messages to authenticated;
grant all on public.messages to service_role;
drop policy if exists messages_member_read on public.messages;
create policy messages_member_read on public.messages for select to authenticated
  using (is_member(business_id));
drop policy if exists messages_member_write on public.messages;
create policy messages_member_write on public.messages for insert to authenticated
  with check (is_member(business_id) and user_id = auth.uid() and direction = 'in');
-- Realtime: the chat page subscribes to new rows (RLS still applies per subscriber).
-- Guarded so a re-run does not fail when the table is already published.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
commit;
