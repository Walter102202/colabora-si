begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select no_plan();

insert into auth.users(id,email) values
  ('30000000-0000-4000-8000-000000000001','search-a@demo.local'),
  ('30000000-0000-4000-8000-000000000002','search-b@demo.local');
insert into public.workspaces(id,name,owner_id) values
  ('30000000-0000-4000-8000-000000000010','Search A','30000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000020','Search B','30000000-0000-4000-8000-000000000002');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','owner'),
  ('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000002','owner');
select set_config('request.jwt.claims','{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.pages(id,workspace_id,parent_id,data) values
  ('s-db','30000000-0000-4000-8000-000000000010',null,'{"id":"s-db","title":"Shared base","blocks":[],"database":{"id":"d1","properties":[{"id":"title","name":"Name","type":"text"}],"rows":[{"id":"r1","pageId":"s-row","cells":{"title":"Café plan"}}],"views":[]}}'),
  ('s-row','30000000-0000-4000-8000-000000000010','s-db','{"id":"s-row","title":"Café plan","blocks":[{"id":"b1","type":"paragraph","indent":0,"html":"Nothing"},{"id":"b2","type":"paragraph","indent":0,"html":"The <b>café</b> opens"}],"comments":[{"id":"c1","body":"árbol secreto","authorId":"30000000-0000-4000-8000-000000000001","authorType":"human","createdAt":1}]}'),
  ('s-plain','30000000-0000-4000-8000-000000000010',null,'{"id":"s-plain","title":"Plain cafe notes","blocks":[]}');
select set_config('request.jwt.claims','{"sub":"30000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
insert into public.pages(id,workspace_id,data) values
  ('s-other','30000000-0000-4000-8000-000000000020','{"id":"s-other","title":"Café other","blocks":[]}');
insert into public.page_shares(page_id,user_id,level) values ('s-other','30000000-0000-4000-8000-000000000001','view');
insert into public.agent_tasks(workspace_id,context_id,row_page_id,title,owner_user_id,created_by)
values ('30000000-0000-4000-8000-000000000010',gen_random_uuid(),'s-row','Café task','30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims','{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select has_function('public','search_workspace',array['uuid','text','text','integer'],'search_workspace exists');
select is((select count(*) from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe'))),4::bigint,'unaccented query finds the database page, the row page, the plain page and the task');
select is((select value->>'kind' from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe')) where value->>'id'='s-row'),'row','a page under a database is a row hit');
select is((select value->>'blockId' from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe')) where value->>'id'='s-row'),'b2','blockId is the first block whose text contains the first term');
select is((select value->>'pageId' from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe')) where value->>'kind'='task'),'s-row','task hits carry the row page id');
select is((select count(*) from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','secreto'))),1::bigint,'comments are indexed');
select is((select jsonb_agg(value->>'id') from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe','s-db'))),'["s-row"]'::jsonb,'database filter keeps only its rows and drops tasks');
select is(public.search_workspace('30000000-0000-4000-8000-000000000010',''),'[]'::jsonb,'blank query returns nothing');
select is((select count(*) from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe',null,2))),2::bigint,'limit is honoured');
select is((select count(*) from jsonb_array_elements(public.search_workspace(null,'cafe')) where value->>'id'='s-other'),1::bigint,'a null workspace returns a page shared from another workspace');
select is((select count(*) from jsonb_array_elements(public.search_workspace('30000000-0000-4000-8000-000000000010','café')) where value->>'id'='s-plain'),1::bigint,'an accented query finds an unaccented title through search_workspace');
select is((select count(*) from jsonb_array_elements(public.search_pages('café')) where value->>'id'='s-plain'),1::bigint,'an accented query finds an unaccented title through search_pages');
select is((select value->>'url' from jsonb_array_elements(public.search_pages('café',10,'task')) limit 1),'/p/s-row','search_pages task branch keeps its url shape and unaccents');
reset role;
select set_config('request.jwt.claims','{"sub":"30000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe'),'[]'::jsonb,'a member of another workspace sees nothing');
reset role;
select set_config('request.jwt.claims','{"role":"anon"}',true);
set local role anon;
select is(public.search_workspace('30000000-0000-4000-8000-000000000010','cafe'),'[]'::jsonb,'anonymous sees nothing unpublished');
reset role;
select is((select count(*) from pg_trigger where tgrelid='public.pages'::regclass and tgenabled='D'),0::bigint,'no trigger on pages remains disabled after the backfill');
select * from finish();
rollback;
