-- Removes the entire staged invite surface from the live project after tests.
drop schema invite_stage cascade;
drop function if exists public.invite_issue(uuid, uuid, text, text, timestamptz);
drop function if exists public.invite_issue_by_phone(text, text, text, timestamptz);
drop function if exists public.invite_redeem(uuid, text, text);
drop function if exists public.invite_revoke(uuid, uuid);
drop function if exists public.invite_set_allowance(uuid, uuid, integer);
drop function if exists public.invite_peek(text);
select (select count(*) from information_schema.schemata where schema_name='invite_stage') as staged_schema_left,
       (select count(*) from information_schema.routines where routine_schema='public' and routine_name like 'invite\_%') as public_wrappers_left;
