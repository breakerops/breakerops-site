delete from invite_stage.audit;
delete from invite_stage.links where request_key like 'race-%';
delete from invite_stage.customers where id in (:CUSTS);
