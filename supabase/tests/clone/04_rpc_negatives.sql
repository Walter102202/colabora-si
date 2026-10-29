begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select no_plan();

insert into auth.users(id,email) values
  ('40000000-0000-4000-8000-000000000001','neg-owner@demo.local'),
  ('40000000-0000-4000-8000-000000000002','neg-viewer@demo.local'),
  ('40000000-0000-4000-8000-000000000003','neg-outsider@demo.local'),
  ('40000000-0000-4000-8000-000000000004','neg-agent@demo.local');
insert into public.workspaces(id,name,owner_id) values ('40000000-0000-4000-8000-000000000010','RPC negatives','40000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('40000000-0000-4000-8000-000000000010','40000000-0000-4000-8000-000000000001','owner'),
  ('40000000-0000-4000-8000-000000000010','40000000-0000-4000-8000-000000000002','viewer');
select set_config('request.jwt.claims','{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.pages(id,workspace_id,data) values ('neg-page','40000000-0000-4000-8000-000000000010','{"id":"neg-page","title":"Negative boundary","blocks":[]}');
insert into public.files(id,workspace_id) values ('neg-file','40000000-0000-4000-8000-000000000010');
insert into public.page_files values ('neg-page','neg-file');
insert into storage.objects(bucket_id,name,owner) values ('files','40000000-0000-4000-8000-000000000010/neg-file/a.png',null);
create temporary table neg_ids(id uuid);
grant select on neg_ids to authenticated;
with n as (insert into public.notifications(workspace_id,user_id,kind) values ('40000000-0000-4000-8000-000000000010','40000000-0000-4000-8000-000000000001','share') returning id) insert into neg_ids select id from n;

select set_config('request.jwt.claims','{"sub":"40000000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{"principal_type":"agent"}}',true);
set local role authenticated;
select throws_ok($$select public.share_page('neg-page','x@demo.local','view')$$,'PT403','humans_only','agents cannot share pages');
select throws_ok($$select * from public.list_page_shares('neg-page')$$,'PT403','humans_only','agents cannot list shares');
select throws_ok($$select public.accept_invitation('token')$$,'PT403','humans_only','agents cannot accept invitations');
select throws_ok($$select public.mark_notifications_read(array[]::uuid[])$$,'PT403','humans_only','agents cannot mark notifications');
select throws_ok($$select public.invite_member('40000000-0000-4000-8000-000000000010','x@demo.local','viewer')$$,'PT403','owner_required','agents cannot invite');
reset role;

select set_config('request.jwt.claims','{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is(public.share_page('neg-page','schema-outsider@demo.local','view'),'You do not have permission to share this page.','a viewer cannot share');
select is((select count(*) from public.list_page_shares('neg-page')),0::bigint,'a viewer lists no shares');
select throws_ok($$select public.invite_member('40000000-0000-4000-8000-000000000010','x@demo.local','viewer')$$,'PT403','owner_required','a non-owner cannot invite');
select throws_ok($$insert into public.files(id,workspace_id) values ('neg-file-2','40000000-0000-4000-8000-000000000010')$$,'42501',null,'a viewer cannot register files');
select public.mark_notifications_read(array[(select id from neg_ids)]);
reset role;

select set_config('request.jwt.claims','{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
-- Read back as the owner so RLS cannot hide a wrongly modified notification.
select is((select count(*) from public.notifications where id=(select id from neg_ids)),1::bigint,'the owner can inspect the notification after the viewer call');
select is((select read_at from public.notifications where id=(select id from neg_ids)),null,'a notification of another user stays unread');
select throws_ok($$select public.invite_member('40000000-0000-4000-8000-000000000010','x@demo.local','owner')$$,'PT422','invalid_role','owner role cannot be invited');
select throws_ok($$select public.accept_invitation('not-a-token')$$,'PT403','invalid_invitation','an unknown token is rejected');
select throws_ok($$select * from public.push_config()$$,'42501',null,'push_config is service_role only');
select throws_ok($$select public.email_config()$$,'42501',null,'email_config is service_role only');
reset role;

select set_config('request.jwt.claims','{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from storage.objects where name like '%neg-file%'),0::bigint,'a non reader does not see the storage object');
select is((select count(*) from public.page_files where file_id='neg-file'),0::bigint,'a non reader does not resolve the page file');
reset role;

select set_config('request.jwt.claims','{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from storage.objects where name like '%neg-file%'),1::bigint,'a member sees the storage object');
reset role;
select * from finish();
rollback;
