-- Acceptance test 4: an agent that is a workspace member with a grant on one page
-- reads nothing else, through PostgREST-style selects, the bundle or storage.
begin;
select plan(13);

select tests.fixture() as f \gset

-- a file attached to page_B, to probe storage
insert into public.files (id, workspace_id) values ('file_b', (:'f'::jsonb->>'ws')::uuid);
insert into public.page_files (page_id, file_id) values ('page_B', 'file_b');
insert into storage.objects (bucket_id, name, owner) values ('files', (:'f'::jsonb->>'ws') || '/file_b/b.png', null);

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);

select results_eq(
  $$ select id from public.pages order by id $$,
  $$ values ('page_A'), ('page_A1') $$,
  'agent sees only page_A and its child');
select is(public.get_page_bundle('page_B'), null, 'bundle of page_B is null for the agent');
select isnt(public.get_page_bundle('page_A'), null, 'bundle of page_A is readable for the agent');
select is((select count(*)::int from storage.objects where name like '%file_b%'), 0, 'storage object of page_B is invisible');
select is((select count(*)::int from public.workspaces), 0, 'agent reads no workspaces');
select is((select count(*)::int from public.workspace_members), 0, 'agent reads no members');
select is((select count(*)::int from public.agents), 1, 'agent reads only its own row');
update public.pages set published = true where id = 'page_B';
select is((select count(*)::int from public.pages where id = 'page_B' and published), 0, 'update of page_B touches 0 rows');
select is(tests.sqlstate_of($$ update public.pages set data = data || '{"title":"x"}' where id = 'page_A' $$), 'PT403', 'direct data update of page_A is rejected (use_apply_page_ops)');

-- revoke in the same session: everything closes
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revoke_agent((:'f'::jsonb->>'agent')::uuid, 'isolation test');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*)::int from public.pages), 0, 'revoked agent reads no pages');
select is(public.get_page_bundle('page_A'), null, 'revoked agent gets no bundle');

-- global kill switch and workspace pause
select tests.reset_role();
update public.agents set status = 'enabled', revoked_at = null where id = (:'f'::jsonb->>'agent')::uuid;
update public.agent_grants set revoked_at = null where agent_id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_service();
select public.set_app_flag('agents_enabled', 'false'::jsonb);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*)::int from public.pages), 0, 'kill switch off: agent reads no pages');
select tests.reset_role();
select tests.set_service();
select public.set_app_flag('agents_enabled', 'true'::jsonb);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.pause_workspace_agents((:'f'::jsonb->>'ws')::uuid, true);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*)::int from public.pages), 0, 'workspace paused: agent reads no pages');

select * from finish();
rollback;
