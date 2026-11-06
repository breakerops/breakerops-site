-- Signup phone verification: one-time text codes before a signup is stored.
-- Service role only, no anon or authenticated access.
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
create index if not exists signup_verifications_created on signup_verifications (created_at);

-- One signup per phone. The function's verify step inserts with
-- ON CONFLICT DO NOTHING against this index. If creating it fails because
-- duplicate phones already exist in signups, dedupe signups first and re-run
-- this statement.
create unique index if not exists signups_phone_unique on signups (phone);
