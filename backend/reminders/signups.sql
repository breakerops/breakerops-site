-- Website signups (phone-first, SMS consent captured verbatim). Applied 2026-10-19.
create table if not exists signups (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  consent_text text not null,
  source text,
  created_at timestamptz not null default now()
);
alter table signups enable row level security;
grant all on signups to service_role;
