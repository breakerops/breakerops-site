-- Session A (start first): holds the customer row lock while sleeping, then commits.
begin;
select set_config('request.jwt.claim.sub', '80f2d1a2-7634-40e8-abf6-904e0aae73b4', true);
select invite_stage.issue(':CUSTOMER:', 'race-a@example.invalid', 'race-a', now() + interval '7 days');
select pg_sleep(8);
commit;
