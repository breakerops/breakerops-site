-- Expected: exactly one pending row for the race phone (request_key race-a).
select request_key, intended_phone from invite_stage.links where request_key like 'race-%' order by request_key;
