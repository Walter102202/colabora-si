begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
select has_table('public', name, name || ' exists') from unnest(array['workspaces','workspace_members','workspace_invitations','pages','page_shares','files','page_files','reminders','push_subscriptions']) name;
select has_table('private', name, name || ' exists') from unnest(array['app_secrets','app_flags','write_receipts']) name;
select has_function('private', name, name || ' exists') from unnest(array['principal_type','is_agent','current_run_id','is_workspace_member','can_edit_workspace','is_human_member','is_human_editor','has_page_share','page_workspace','page_text','agent_can_read','agent_can_write','can_read_page','can_write_page']) name;
select has_trigger('public', 'pages', name, name || ' exists') from unnest(array['pages_touch','pages_touch_insert','pages_10_protect_columns','pages_20_revision','pages_30_actor','maintain_page_search','maintain_page_files']) name;
select has_trigger('public', 'workspaces', name, name || ' exists') from unnest(array['workspaces_touch','workspaces_protect_owner','workspaces_20_revision']) name;

insert into auth.users(id, email) values
  ('10000000-0000-4000-8000-000000000001', 'schema-owner@demo.local'),
  ('10000000-0000-4000-8000-000000000002', 'schema-viewer@demo.local'),
  ('10000000-0000-4000-8000-000000000003', 'schema-outsider@demo.local');
insert into public.workspaces(id, name, owner_id) values ('10000000-0000-4000-8000-000000000010', 'Schema test', '10000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', 'owner'),
  ('10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000002', 'viewer');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into public.pages(id, workspace_id, data, published) values
  ('schema-private', '10000000-0000-4000-8000-000000000010', '{"id":"schema-private","title":"Private","blocks":[]}', false),
  ('schema-public', '10000000-0000-4000-8000-000000000010', '{"id":"schema-public","title":"Public","blocks":[]}', true);
set local role authenticated;
select is((select count(*) from public.pages where workspace_id = '10000000-0000-4000-8000-000000000010'), 2::bigint, 'member reads workspace pages');
select throws_ok($$update public.pages set data = '{}' where id = 'schema-private'$$, 'PT403', 'use_apply_page_ops', 'direct content update is rejected');
update public.pages set last_edited_by = '10000000-0000-4000-8000-000000000003', last_edited_by_type = 'agent' where id = 'schema-private';
select is((select last_edited_by from public.pages where id = 'schema-private'), '10000000-0000-4000-8000-000000000001'::uuid, 'server seals actor id');
select is((select last_edited_by_type from public.pages where id = 'schema-private'), 'human', 'server seals actor type');
reset role;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.pages where workspace_id = '10000000-0000-4000-8000-000000000010'), 2::bigint, 'viewer reads pages');
select results_eq($$with changed as (update public.pages set published = true where id = 'schema-private' returning id) select count(*) from changed$$, array[0::bigint], 'viewer cannot write pages');
reset role;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.pages where id = 'schema-private'), 0::bigint, 'nonmember cannot read private page');
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select results_eq($$select id from public.pages where id like 'schema-%' order by id$$, array['schema-public'::text], 'anonymous reads only published pages');
reset role;
select * from finish();
rollback;
