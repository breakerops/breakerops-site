-- Staged invitation core. Load only in an isolated transaction for tests until reviewed.
-- No public RPC wrappers, no emails, no live customer provisioning.
create schema if not exists invite_stage;
revoke all on schema invite_stage from public, anon, authenticated;
create table invite_stage.settings (singleton boolean primary key default true check(singleton), activation_enabled boolean not null default false);
insert into invite_stage.settings values(true,false);
create table invite_stage.customers (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null,
 active boolean not null default true,
 allowance integer not null default 5 check(allowance>=0)
);
create table invite_stage.links (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references invite_stage.customers(id),
 token_hash text not null unique,
 intended_email text not null check(intended_email=lower(trim(intended_email)) and intended_email like '%@%'),
 request_key text not null,
 issued_by uuid not null,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 accepted_by uuid,
 accepted_business_id uuid,
 accepted_at timestamptz,
 unique(customer_id,request_key)
);
-- Deliberately separate staged businesses, not public.businesses: no pricing defaults.
create table invite_stage.businesses (id uuid primary key default gen_random_uuid(),name text not null,owner_user_id uuid not null unique,source_invite uuid not null unique references invite_stage.links(id));
create table invite_stage.audit (id bigint generated always as identity,event text not null,actor uuid,link_id uuid,created_at timestamptz not null default now());
create function invite_stage.set_allowance(customer uuid, amount integer) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is distinct from '80f2d1a2-7634-40e8-abf6-904e0aae73b4'::uuid then raise exception 'forbidden'; end if;
 if amount<0 then raise exception 'invalid allowance'; end if;
 update invite_stage.customers set allowance=amount where id=customer;
 if not found then raise exception 'unknown customer'; end if;
 insert into invite_stage.audit(event,actor) values('allowance_updated',auth.uid());
end $$;
create function invite_stage.issue(customer uuid, email text, retry_key text, expires timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare c invite_stage.customers; existing invite_stage.links; raw text; link_id uuid; reserved integer;
begin
 select * into c from invite_stage.customers where id=customer for update;
 if not found or not c.active then raise exception 'not admitted'; end if;
 if auth.uid() is distinct from c.owner_user_id then raise exception 'forbidden'; end if;
 if retry_key is null or length(retry_key)<1 then raise exception 'request key required'; end if;
 select * into existing from invite_stage.links where customer_id=customer and request_key=retry_key;
 if found then
  if existing.intended_email<>lower(trim(email)) then raise exception 'idempotency conflict'; end if;
  return jsonb_build_object('id',existing.id,'already_issued',true,'token',null);
 end if;
 if expires<=now() then raise exception 'invalid expiry'; end if;
 select count(*) into reserved from invite_stage.links where customer_id=customer and (accepted_at is not null or (revoked_at is null and expires_at>now()));
 if reserved>=c.allowance then raise exception 'allowance exhausted'; end if;
 raw=encode(extensions.gen_random_bytes(32),'hex');
 insert into invite_stage.links(customer_id,token_hash,intended_email,request_key,issued_by,expires_at)
 values(customer,encode(extensions.digest(raw,'sha256'),'hex'),lower(trim(email)),retry_key,auth.uid(),expires) returning id into link_id;
 insert into invite_stage.audit(event,actor,link_id) values('issued',auth.uid(),link_id);
 return jsonb_build_object('id',link_id,'token',raw,'already_issued',false);
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
create function invite_stage.redeem(raw_token text, business_name text) returns uuid language plpgsql security definer set search_path='' as $$
declare l invite_stage.links; c invite_stage.customers; uid uuid; verified_email text; cid uuid; bid uuid;
begin
 if not (select activation_enabled from invite_stage.settings where singleton) then raise exception 'activation disabled'; end if;
 uid=auth.uid();
 select lower(email) into verified_email from auth.users where id=uid and email_confirmed_at is not null;
 if verified_email is null then raise exception 'verified identity required'; end if;
 select customer_id into cid from invite_stage.links where token_hash=encode(extensions.digest(raw_token,'sha256'),'hex');
 select * into c from invite_stage.customers where id=cid for update;
 if not found or not c.active then raise exception 'invalid invitation'; end if;
 select * into l from invite_stage.links where token_hash=encode(extensions.digest(raw_token,'sha256'),'hex') for update;
 if l.intended_email<>verified_email then raise exception 'recipient mismatch'; end if;
 if l.accepted_by=uid then return l.accepted_business_id; end if;
 if l.accepted_at is not null or l.revoked_at is not null or l.expires_at<=now() then raise exception 'invalid invitation'; end if;
 if length(trim(business_name))=0 then raise exception 'business name required'; end if;
 insert into invite_stage.businesses(name,owner_user_id,source_invite) values(trim(business_name),uid,l.id) returning id into bid;
 update invite_stage.links set accepted_by=uid,accepted_business_id=bid,accepted_at=now() where id=l.id;
 insert into invite_stage.audit(event,actor,link_id) values('accepted',uid,l.id);
 return bid;
end $$;
revoke all on all functions in schema invite_stage from public,anon,authenticated;
revoke all on all tables in schema invite_stage from public,anon,authenticated;
