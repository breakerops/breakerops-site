-- Race-test fixture: one committed customer with allowance 1, owned by Jake's user id.
-- Run after invite-core.sql is loaded. Capture the returned id for the two session files.
insert into invite_stage.customers(owner_user_id, allowance)
values ('80f2d1a2-7634-40e8-abf6-904e0aae73b4', 1)
returning id;
