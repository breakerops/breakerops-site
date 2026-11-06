-- Signup phone verification: one-time text codes before a signup is stored.
-- Approved by Jake 2026-11-06. Service role only, no anon or authenticated access.
create table if not exists signup_verifications (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  ip_hash text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz
);
alter table signup_verifications enable row level security;
grant all on signup_verifications to service_role;
create index if not exists signup_verifications_phone_created on signup_verifications (phone, created_at desc);
create index if not exists signup_verifications_ip_created on signup_verifications (ip_hash, created_at desc);
