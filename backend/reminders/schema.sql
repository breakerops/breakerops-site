-- BreakerOps reminder engine, product-owned. No human in the loop.
-- Apply in the Supabase SQL editor. Idempotent.

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  recipient_channel text not null check (recipient_channel in ('sms','email','log')),
  recipient text not null check (length(trim(recipient)) > 0),
  body text not null check (length(trim(body)) > 0),
  send_at timestamptz not null,               -- absolute time, offset required
  idempotency_key text not null check (length(trim(idempotency_key)) > 0),
  status text not null default 'pending'
    check (status in ('pending','claimed','sent','failed','uncertain','cancelled')),
  attempts integer not null default 0,
  provider_id text,
  error text,
  created_by text not null,                   -- which conversation backend wrote it, e.g. 'instinct-matt'
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (business_id, idempotency_key)
);

create index if not exists reminders_due_idx
  on public.reminders (send_at) where status = 'pending';

alter table public.reminders enable row level security;

-- Customers can read their own business's reminders; only the service role writes.
drop policy if exists reminders_member_read on public.reminders;
create policy reminders_member_read on public.reminders
  for select using (
    exists (
      select 1 from public.business_members m
      where m.business_id = reminders.business_id
        and m.user_id = auth.uid()
    )
  );

-- Atomic claim: picks due reminders once, safe under repeated cron runs.
create or replace function public.claim_due_reminders(batch_size integer default 25)
returns setof public.reminders language sql as $$
  update public.reminders
     set status = 'claimed', attempts = attempts + 1
   where id in (
     select id from public.reminders
      where status = 'pending' and send_at <= now()
      order by send_at
      limit batch_size
      for update skip locked
   )
  returning *;
$$;

-- Customer-facing cancel/change: mark cancelled; claimed rows are left for the sender to skip.
create or replace function public.cancel_reminder(p_business uuid, p_idempotency_key text)
returns integer language sql as $$
  update public.reminders
     set status = 'cancelled'
   where business_id = p_business
     and idempotency_key = p_idempotency_key
     and status = 'pending';
  select 1;
$$;

-- Conversation model setting: which model the product's conversation uses.
-- Switch = flip one row in the backend, no code changes.
-- The API key itself is never stored here, only the NAME of the function secret holding it.
create table if not exists public.model_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                  -- 'instinct', 'gemini', ...
  kind text not null check (kind in ('manual','openai_compatible')),
  endpoint text,                              -- base URL, required for openai_compatible
  model text,                                 -- model name at that provider
  api_key_secret text,                        -- NAME of the edge-function secret, not the key
  active boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

-- Exactly one active provider.
create unique index if not exists one_active_provider
  on public.model_providers (active) where active;

alter table public.model_providers enable row level security;
-- No select policy: service role only. Admin changes happen in the backend, not the browser app.

insert into public.model_providers (name, kind, active, notes) values
  ('instinct', 'manual', true,
   'Default. No public Instinct API exists (verified 2026-10-17); conversations run concierge-style until a real provider endpoint replaces this.')
on conflict (name) do nothing;
