-- Admin site (breakerops.com/admin): owner-only connections store + overview RPCs. Applied Oct 18, 2026.
-- Owner check pins Jake's auth user id; all functions reject every other caller (anon included).

create table if not exists private.connections (
  provider text primary key,
  api_key text,
  meta jsonb default '{}',
  updated_by uuid,
  updated_at timestamptz default now()
);
alter table private.connections enable row level security;

create or replace function is_admin() returns boolean language sql stable security definer as
$$ select auth.uid() = '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid $$;

create or replace function set_connection(p_provider text, p_key text) returns void language plpgsql security definer as
$$ begin
  if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'not allowed'; end if;
  insert into private.connections (provider, api_key, updated_by, updated_at)
  values (p_provider, p_key, auth.uid(), now())
  on conflict (provider) do update set api_key=excluded.api_key, updated_by=excluded.updated_by, updated_at=now();
end $$;

create or replace function connection_status() returns table(provider text, connected boolean, key_hint text, updated_at timestamptz) language plpgsql security definer as
$$ begin
  if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'not allowed'; end if;
  return query select c.provider, c.api_key is not null and c.api_key<>'', '...'||right(c.api_key,4), c.updated_at from private.connections c;
end $$;

create or replace function admin_overview() returns json language sql security definer as
$$ select case when is_admin() then json_build_object(
  'plan',(select row_to_json(b) from (select name,plan_texts,overage_cents,plan_price_cents,addon_user_cents from businesses limit 1) b),
  'usage',(select coalesce(json_agg(row_to_json(v)),'[]'::json) from v_usage_billing v)) else null end $$;
