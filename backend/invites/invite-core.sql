-- Phone-first invitation core, v2. Staged; load only in an isolated transaction for
-- tests until reviewed. No public RPC wrappers, no SMS, no live customer provisioning.
-- Model (Jake, Oct 20): invites are bound to the buddy's PHONE number, not email.
-- No token, link, account, or login at invite time. Redemption happens when the
-- invited phone texts Matt; the buddy just starts texting. The Home Screen app and
-- any phone-ownership verification come days later and are a separate concern.
create schema if not exists invite_stage;
revoke all on schema invite_stage from public, anon, authenticated;

create table invite_stage.settings (singleton boolean primary key default true check(singleton), activation_enabled boolean not null default false);
insert into invite_stage.settings values(true,false);

create table invite_stage.customers (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null,
 active boolean not null default true,
 allowance integer not null default 5 check(allowance>=0),
 phone text unique check(phone ~ '^\+[1-9]\d{7,14}$')
);

create table invite_stage.links (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references invite_stage.customers(id),
 intended_phone text not null check(intended_phone ~ '^\+[1-9]\d{7,14}$'),
 request_key text not null,
 issued_by uuid not null,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 accepted_business_id uuid,
 accepted_at timestamptz,
 unique(customer_id,request_key)
);
-- At most one pending invitation per phone, across all customers.
create unique index one_pending_per_phone on invite_stage.links(intended_phone) where accepted_at is null and revoked_at is null;

-- Phone-owned business: created at redemption with no name (learned in conversation)
-- and no auth account (bound later, if ever, at the Home Screen step).
create table invite_stage.businesses (
 id uuid primary key default gen_random_uuid(),
 owner_phone text not null unique check(owner_phone ~ '^\+[1-9]\d{7,14}$'),
 name text,
 owner_user_id uuid unique,
 source_invite uuid not null unique references invite_stage.links(id),
 created_at timestamptz not null default now()
);

create table invite_stage.audit (id bigint generated always as identity,event text not null,actor uuid,link_id uuid,created_at timestamptz not null default now());

create function invite_stage.set_allowance(customer uuid, amount integer) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'forbidden'; end if;
 if amount<0 then raise exception 'invalid allowance'; end if;
 update invite_stage.customers set allowance=amount where id=customer;
 if not found then raise exception 'unknown customer'; end if;
 insert into invite_stage.audit(event,actor) values('allowance_updated',auth.uid());
end $$;

-- Admin-only (Jake): bind a customer's texting phone so the desk can recognize them.
create function invite_stage.bind_phone(p_customer uuid, p_phone text) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'forbidden'; end if;
 update invite_stage.customers set phone=p_phone where id=p_customer;
 if not found then raise exception 'unknown customer'; end if;
 insert into invite_stage.audit(event,actor) values('phone_bound',auth.uid());
end $$;

-- Issue an invitation for a buddy's phone. Quota: accepted + pending-unexpired-unrevoked.
-- Serializes per-customer (row lock) and per-phone (transaction advisory lock).
create function invite_stage.issue(customer uuid, phone text, retry_key text, expires timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare c invite_stage.customers; existing invite_stage.links; pending invite_stage.links; link_id uuid; reserved integer;
begin
 select * into c from invite_stage.customers where id=customer for update;
 if not found or not c.active then raise exception 'not admitted'; end if;
 if auth.uid() is distinct from c.owner_user_id then raise exception 'forbidden'; end if;
 if retry_key is null or length(retry_key)<1 then raise exception 'request key required'; end if;
 perform pg_advisory_xact_lock(hashtext(phone));
 select * into existing from invite_stage.links where customer_id=customer and request_key=retry_key;
 if found then
  if existing.intended_phone<>phone then raise exception 'idempotency conflict'; end if;
  return jsonb_build_object('id',existing.id,'already_issued',true);
 end if;
 if expires<=now() then raise exception 'invalid expiry'; end if;
 if exists(select 1 from invite_stage.businesses where owner_phone=phone) then raise exception 'already admitted'; end if;
 if exists(select 1 from invite_stage.customers cu where cu.phone=issue.phone) then raise exception 'phone is a customer'; end if;
 select * into pending from invite_stage.links where intended_phone=phone and accepted_at is null and revoked_at is null;
 if found then
  if pending.expires_at>now() then raise exception 'phone already invited'; end if;
  update invite_stage.links set revoked_at=now() where id=pending.id;  -- lazy reclaim of expired pending invite
  insert into invite_stage.audit(event,actor,link_id) values('expired_reclaimed',auth.uid(),pending.id);
 end if;
 select count(*) into reserved from invite_stage.links where customer_id=customer and (accepted_at is not null or (revoked_at is null and expires_at>now()));
 if reserved>=c.allowance then raise exception 'allowance exhausted'; end if;
 insert into invite_stage.links(customer_id,intended_phone,request_key,issued_by,expires_at)
 values(customer,phone,retry_key,auth.uid(),expires) returning id into link_id;
 insert into invite_stage.audit(event,actor,link_id) values('issued',auth.uid(),link_id);
 return jsonb_build_object('id',link_id,'already_issued',false);
end $$;

create function invite_stage.revoke(link uuid) returns void language plpgsql security definer set search_path='' as $$
declare c invite_stage.customers; l invite_stage.links; cid uuid;
begin
 select customer_id into cid from invite_stage.links where id=link;
 select * into c from invite_stage.customers where id=cid for update;
 if auth.uid() is distinct from c.owner_user_id and auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'forbidden'; end if;
 select * into l from invite_stage.links where id=link for update;
 if l.accepted_at is not null then raise exception 'already accepted'; end if;
 update invite_stage.links set revoked_at=coalesce(revoked_at,now()) where id=link;
 insert into invite_stage.audit(event,actor,link_id) values('revoked',auth.uid(),link);
end $$;

-- Redemption = the invited phone's first inbound text. Called by the inbound SMS
-- handler (service only). Returns admission status for routing:
--   admitted: new separate business created, invite consumed
--   member:   phone already owns a business (route to conversation)
--   none:     no invite, no business (treat as public lead)
create function invite_stage.redeem_on_inbound(phone text) returns jsonb language plpgsql security definer set search_path='' as $$
declare l invite_stage.links; b invite_stage.businesses; bid uuid;
begin
 if not (select activation_enabled from invite_stage.settings where singleton) then raise exception 'activation disabled'; end if;
 perform pg_advisory_xact_lock(hashtext(phone));
 select * into b from invite_stage.businesses where owner_phone=phone;
 if found then return jsonb_build_object('status','member','business_id',b.id,'business_name',b.name); end if;
 select * into l from invite_stage.links
  where intended_phone=phone and accepted_at is null and revoked_at is null and expires_at>now()
  order by expires_at desc limit 1 for update;
 if not found then return jsonb_build_object('status','none'); end if;
 insert into invite_stage.businesses(owner_phone,source_invite) values(phone,l.id) returning id into bid;
 update invite_stage.links set accepted_business_id=bid,accepted_at=now() where id=l.id;
 insert into invite_stage.audit(event,actor,link_id) values('accepted',null,l.id);
 return jsonb_build_object('status','admitted','business_id',bid,'invite_id',l.id,'inviter_customer_id',l.customer_id);
end $$;

-- Later, Home Screen step: bind a phone-verified auth account to the phone-owned
-- business. The caller must prove account ownership AND phone possession out of band
-- (e.g. phone OTP session); this function only performs the binding itself.
create function invite_stage.bind_business_account(phone text, account uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare b invite_stage.businesses;
begin
 if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'forbidden'; end if;
 select * into b from invite_stage.businesses where owner_phone=phone for update;
 if not found then raise exception 'unknown business phone'; end if;
 if b.owner_user_id is not null and b.owner_user_id is distinct from account then raise exception 'business already bound'; end if;
 update invite_stage.businesses set owner_user_id=account,name=coalesce(name,name) where id=b.id;
 insert into invite_stage.audit(event,actor) values('account_bound',auth.uid());
 return b.id;
end $$;

revoke all on all functions in schema invite_stage from public,anon,authenticated;
revoke all on all tables in schema invite_stage from public,anon,authenticated;
