-- Session B (start ~3s after A): must block on the advisory lock, then fail 'phone already invited'.
begin;
select set_config('request.jwt.claim.sub', '80f2d1a2-7634-40e8-abf6-904e0aae73b4', true);
select invite_stage.issue(':CUST_B:', '+15557654321', 'race-b', now() + interval '7 days');
commit;
