-- Session B (start ~3s after A): must block on the row lock, then fail with 'allowance exhausted'.
begin;
select set_config('request.jwt.claim.sub', '80f2d1a2-7634-40e8-abf6-904e0aae73b4', true);
select invite_stage.issue(':CUSTOMER:', 'race-b@example.invalid', 'race-b', now() + interval '7 days');
commit;
