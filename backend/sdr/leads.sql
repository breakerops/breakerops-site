-- SDR leads + outreach tracking. Service role only. Applied 2026-10-19.
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  trade text,
  contact_name text,
  email text,
  phone text,
  website text,
  city text,
  state text,
  source_url text,
  batch text,
  status text not null default 'new' check (status in ('new','drafted','approved','sent','replied','handed_off','dead')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table leads enable row level security;
grant all on leads to service_role;

create table if not exists outreach_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  subject text,
  body text not null,
  from_address text not null default 'nick@breakerops.com',
  status text not null default 'draft' check (status in ('draft','approved','sent','bounced','replied')),
  sent_at timestamptz,
  gmail_message_id text,
  created_at timestamptz not null default now()
);
alter table outreach_messages enable row level security;
grant all on outreach_messages to service_role;
