begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select no_plan();
insert into auth.users(id,email,email_confirmed_at) values
 ('60000000-0000-4000-8000-000000000001','access-owner@test.local',now()),
 ('60000000-0000-4000-8000-000000000002','access-first@test.local',now()),
 ('60000000-0000-4000-8000-000000000003','access-second@test.local',now());
insert into public.workspaces(id,owner_id) values
 ('60000000-0000-4000-8000-000000000010','60000000-0000-4000-8000-000000000001'),
 ('60000000-0000-4000-8000-000000000011','60000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select lives_ok($$insert into workspace_members(workspace_id,user_id,role) values('60000000-0000-4000-8000-000000000010','60000000-0000-4000-8000-000000000001','owner')$$,'bootstrap owner still works');
select throws_ok($$insert into workspace_members(workspace_id,user_id,role) values('60000000-0000-4000-8000-000000000010','60000000-0000-4000-8000-000000000003','editor')$$,'42501',null,'owner cannot insert another member');
select throws_ok($$insert into workspace_invitations(workspace_id,email,role,token_hash) values('60000000-0000-4000-8000-000000000010','bypass@test.local','editor','bypass')$$,'42501',null,'direct invitation is denied');
select is(invite_member('60000000-0000-4000-8000-000000000010',' ACCESS-FIRST@test.local ','editor')->>'status','joined','first confirmed person joins');
select lives_ok($$select invite_member('60000000-0000-4000-8000-000000000011','access-first@test.local','viewer')$$,'same email in another workspace reuses slot');
select throws_ok($$select invite_member('60000000-0000-4000-8000-000000000011','access-second@test.local','viewer')$$,'PT403','invite_limit_reached','global owner limit includes existing users');
select throws_ok($$select invite_member('60000000-0000-4000-8000-000000000010','new@test.local','viewer')$$,'PT403','invite_limit_reached','limit includes new accounts');
select throws_ok($$update workspace_members set user_id='60000000-0000-4000-8000-000000000003' where user_id='60000000-0000-4000-8000-000000000002'$$,'42501',null,'member identity cannot be changed');
delete from workspace_members where user_id='60000000-0000-4000-8000-000000000002';
select throws_ok($$select invite_member('60000000-0000-4000-8000-000000000010','new@test.local','viewer')$$,'PT403','invite_limit_reached','removal does not refund');
select lives_ok($$select invite_member('60000000-0000-4000-8000-000000000010','access-first@test.local','viewer')$$,'removed person can be reinvited');
select throws_ok($$select account_link_target('access-first@test.local',null)$$,'42501',null,'member cannot inspect accounts');
select throws_ok($$select account_link_allowed('ip','email')$$,'42501',null,'member cannot consume or inspect public rate limits');
reset role;
set local role anon;
select throws_ok($$select account_link_target('access-first@test.local',null)$$,'42501',null,'anonymous cannot inspect accounts');
select throws_ok($$select account_link_allowed('ip','email')$$,'42501',null,'anonymous cannot bypass function limits');
reset role;
select * from finish();
rollback;
