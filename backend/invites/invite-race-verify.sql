-- Expected: exactly one row, request_key 'race-a'. Any 'race-b' row means the quota raced.
select request_key, intended_email, accepted_at from invite_stage.links where request_key like 'race-%' order by request_key;
