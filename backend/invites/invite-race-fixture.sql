-- Race fixture v2: two committed customers; both race to invite the same phone.
insert into invite_stage.customers(owner_user_id, allowance) values
 ('80f2d1a2-7634-40e8-abf6-904e0aae73b4', 5),
 ('80f2d1a2-7634-40e8-abf6-904e0aae73b4', 5)
returning id;
