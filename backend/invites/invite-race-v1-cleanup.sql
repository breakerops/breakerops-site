delete from invite_stage.audit where link_id in (select id from invite_stage.links where request_key like 'race-%');
delete from invite_stage.links where request_key like 'race-%';
delete from invite_stage.customers where id = ':CUSTOMER:';
