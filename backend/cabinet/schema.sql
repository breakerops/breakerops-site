-- BreakerOps Dan backend ("the cabinet") - schema v1
-- Built to Matt's Dan text-interface handoff v1 (Oct 28) + Dan doc Part 7.
-- ADDITIVE ONLY: new tables/functions; does not alter or re-apply any existing
-- live object (live DB has drifted from repo - surgical apply via dashboard SQL).
--
-- Rules encoded here (from the handoff):
--  * tenant auth on every table (business_members / is_member())
--  * inbound messages + source attachments are IMMUTABLE (insert/select only)
--  * derived values stored separately from the immutable source
--  * dedupe by provider message/attachment id + tenant (idempotent capture key)
--  * every mutable record carries source refs + state + version + history
--  * corrections keep the original plus an audit trail (no silent overwrite)
--  * outbound lifecycle: draft -> approved(version+recipient+channel)
--    -> sending -> sent/failed/unknown; material edit invalidates approval
--  * schedule proposals: owner plan separate from customer-confirmed
--  * warranty term never inferred ('term not recorded' when null)

-- idempotent backfill for tables possibly created before business_id was added
alter table if exists public.source_attachments add column if not exists business_id uuid references public.businesses(id);
alter table if exists public.attachment_fields add column if not exists business_id uuid references public.businesses(id);
alter table if exists public.message_parses add column if not exists business_id uuid references public.businesses(id);

-- 0. customers (cabinet folder per customer)
create table if not exists public.cabinet_customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  name text not null,
  phone text,
  address text,
  notes text not null default '',
  created_by text not null default 'text-capture',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table public.cabinet_customers enable row level security;

-- 1. jobs (subfolder per job)
create table if not exists public.cabinet_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  customer_id uuid references public.cabinet_customers(id),
  title text not null,
  status text not null default 'open', -- open | done | archived
  source_ref uuid, -- inbound message that created it, when known
  created_by text not null default 'text-capture',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table public.cabinet_jobs enable row level security;
create index if not exists cabinet_jobs_biz_idx on public.cabinet_jobs(business_id, status);

-- 2. inbound messages (IMMUTABLE source of truth)
create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  provider text not null default 'telnyx',
  provider_message_id text not null,
  channel text not null default 'sms',
  from_phone text not null,
  to_phone text,
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (business_id, provider, provider_message_id) -- idempotent capture key
);
alter table public.inbound_messages enable row level security;
-- immutability enforced by grants: select+insert only (no update/delete for app roles)

-- 3. source attachments (IMMUTABLE)
create table if not exists public.source_attachments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  inbound_message_id uuid not null references public.inbound_messages(id),
  provider_attachment_id text,
  mime_type text,
  byte_size int,
  storage_path text, -- private bucket path; attachment URLs must be tenant-scoped signed URLs
  processing_status text not null default 'pending', -- pending|ok|failed (per-item success/failure)
  processing_detail text not null default '',
  created_at timestamptz not null default now(),
  unique (inbound_message_id, provider_attachment_id)
);
alter table public.source_attachments enable row level security;

-- 4. derived values (suggested fields + confidence), separate from source
create table if not exists public.attachment_fields (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  attachment_id uuid not null references public.source_attachments(id),
  field text not null,       -- e.g. vendor, date, total_cents, job_hint
  value jsonb not null,
  confidence numeric,        -- 0..1
  created_at timestamptz not null default now()
);
alter table public.attachment_fields enable row level security;

-- 5. unbilled extras ('Miller job, added outlet, $180' - never an invoice)
create table if not exists public.unbilled_extras (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  job_id uuid not null references public.cabinet_jobs(id),
  source_ref uuid references public.inbound_messages(id),
  description text not null,
  amount_cents int,          -- null when the owner never named a price; never invented
  state text not null default 'recorded', -- recorded|invoiced|voided
  version int not null default 1,
  created_by text not null default 'text-capture',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.unbilled_extras enable row level security;

-- 6. invoices + payment observations (money view)
create table if not exists public.cabinet_invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  job_id uuid references public.cabinet_jobs(id),
  source_ref uuid references public.inbound_messages(id),
  amount_cents int,
  issued_at timestamptz,
  due_at timestamptz,
  state text not null default 'open', -- open|paid|void
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cabinet_invoices enable row level security;

create table if not exists public.payment_observations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  invoice_id uuid references public.cabinet_invoices(id),
  amount_cents int,
  observed_at timestamptz not null default now(),
  source text not null,      -- 'owner_reported' | 'bank' | ... (owner-reported is NOT bank-verified)
  note text not null default '',
  source_ref uuid references public.inbound_messages(id)
);
alter table public.payment_observations enable row level security;

-- 7. warranty / callback records
create table if not exists public.warranty_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  job_id uuid not null references public.cabinet_jobs(id),
  item text not null,
  installed_at date,
  term_text text,            -- null renders as 'term not recorded'; never inferred
  notes text not null default '',
  source_ref uuid references public.inbound_messages(id),
  state text not null default 'active', -- active|claimed|expired|void
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.warranty_records enable row level security;

-- 8. schedule proposals (owner plan separate from customer-confirmed)
create table if not exists public.schedule_proposals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  job_id uuid references public.cabinet_jobs(id),
  proposed_start timestamptz,
  proposed_end timestamptz,
  state text not null default 'owner_plan', -- owner_plan|proposed|customer_confirmed|declined|canceled
  source_ref uuid references public.inbound_messages(id),
  version int not null default 1,
  created_by text not null default 'text-capture',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.schedule_proposals enable row level security;

-- 9. outbound drafts (nothing sends; lifecycle enforced)
create table if not exists public.outbound_drafts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  kind text not null,        -- chase|change_order_draft|followup|other
  job_id uuid references public.cabinet_jobs(id),
  recipient_channel text not null default 'sms',
  recipient text not null,
  body text not null,
  source_refs jsonb not null default '[]'::jsonb,
  version int not null default 1,
  approved_version int,      -- approval binds to this exact version
  approved_by uuid,
  approved_at timestamptz,
  state text not null default 'draft', -- draft|approved|sending|sent|failed|unknown|canceled
  state_detail text not null default '',
  created_by text not null default 'text-capture',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.outbound_drafts enable row level security;
-- material edit invalidates approval
create or replace function public.outbound_draft_touch() returns trigger
language plpgsql as $$
begin
  if new.body is distinct from old.body
     or new.recipient is distinct from old.recipient
     or new.recipient_channel is distinct from old.recipient_channel then
    new.version := old.version + 1;
    new.approved_version := null;
    new.approved_by := null;
    new.approved_at := null;
    if old.state in ('approved') then new.state := 'draft'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists outbound_draft_touch on public.outbound_drafts;
create trigger outbound_draft_touch before update on public.outbound_drafts
  for each row execute function public.outbound_draft_touch();

-- 10. resolution queue (one blocking question bound to the source message)
create table if not exists public.resolution_queue (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  source_ref uuid references public.inbound_messages(id),
  question text not null,
  options jsonb not null default '[]'::jsonb, -- candidate jobs/customers
  status text not null default 'open', -- open|resolved|expired
  resolution jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.resolution_queue enable row level security;

-- 11. correction/audit history (corrections keep the original)
create table if not exists public.cabinet_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  entity_table text not null,
  entity_id uuid not null,
  changed_by text not null default 'text-capture',
  change_kind text not null, -- create|correct|state|void
  old jsonb,
  new jsonb,
  created_at timestamptz not null default now()
);
alter table public.cabinet_history enable row level security;
create index if not exists cabinet_history_entity_idx on public.cabinet_history(entity_table, entity_id);

-- 12. private exports (owner-only, manifest of what was exported)
create table if not exists public.cabinet_exports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  job_id uuid references public.cabinet_jobs(id),
  manifest jsonb not null,   -- every record/attachment included, with source refs
  storage_path text,         -- private bucket path
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.cabinet_exports enable row level security;

-- RLS policies: tenant members read/write their business rows; immutable
-- tables get insert+select only (no update/delete policies = no updates).
do $$
declare t text;
begin
  foreach t in array array[
    'cabinet_customers','cabinet_jobs','unbilled_extras','cabinet_invoices',
    'payment_observations','warranty_records','schedule_proposals',
    'outbound_drafts','resolution_queue','cabinet_history','cabinet_exports',
    'inbound_messages','source_attachments','attachment_fields']
  loop
    execute format('drop policy if exists member_select on public.%I;', t);
    execute format('drop policy if exists member_insert on public.%I;', t);
    execute format('drop policy if exists member_update on public.%I;', t);
    execute format(
      'create policy member_select on public.%I for select using (public.is_member(%I.business_id));',
      t, t);
    execute format(
      'create policy member_insert on public.%I for insert with check (public.is_member(%I.business_id));',
      t, t);
    if t not in ('inbound_messages','source_attachments','attachment_fields','cabinet_history') then
      execute format(
        'create policy member_update on public.%I for update using (public.is_member(%I.business_id));',
        t, t);
    end if;
  end loop;
end $$;

-- 13. parser output, versioned, stored separately from the immutable source
create table if not exists public.message_parses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  inbound_message_id uuid not null references public.inbound_messages(id),
  parser_version text not null,
  kind text,                 -- extra|receipt|warranty|schedule|money_query|other
  output jsonb not null default '{}'::jsonb,
  confidence numeric,
  created_at timestamptz not null default now()
);
alter table public.message_parses enable row level security;
create index if not exists message_parses_msg_idx on public.message_parses(inbound_message_id);

-- 14. phone -> tenant mapping (identity binding; see handoff: never trust
-- business id, sender name or message text as identity)
create table if not exists public.phone_identities (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  user_id uuid,
  phone text not null,
  verified_at timestamptz,   -- null = unverified; capture only binds on verified
  verification_method text,
  created_at timestamptz not null default now(),
  unique (phone)
);
alter table public.phone_identities enable row level security;

-- RLS for the two additions
do $$
declare t text;
begin
  foreach t in array array['message_parses','phone_identities'] loop
    execute format('drop policy if exists member_select on public.%I;', t);
    execute format('drop policy if exists member_insert on public.%I;', t);
    execute format('drop policy if exists member_update on public.%I;', t);
    execute format(
      'create policy member_select on public.%I for select using (public.is_member(%I.business_id));',
      t, t);
    execute format(
      'create policy member_insert on public.%I for insert with check (public.is_member(%I.business_id));',
      t, t);
  end loop;
  -- phone_identities: members may verify/re-verify phones in their business
  execute 'drop policy if exists member_update on public.phone_identities;';
  execute 'create policy member_update on public.phone_identities for update using (public.is_member(phone_identities.business_id));';
  -- message_parses: derived data; allow insert+select only
end $$;

-- customer_authorization on unbilled extras (never claimed, never an invoice)
alter table public.unbilled_extras
  add column if not exists customer_authorization text not null default 'unknown';
