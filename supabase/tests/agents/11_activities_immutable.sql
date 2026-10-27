begin;
select plan(9);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_C');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_D');

-- Three tasks: on page_A1 (agent has an inherited read grant), on page_C delegated to the agent, on page_D (neither).
insert into public.agent_tasks (id, workspace_id, context_id, row_page_id, owner_user_id, created_by, delegate_agent_id) values
  ('a0000000-0000-4000-8000-000000000001', (:'f'::jsonb->>'ws')::uuid, 'a0000000-0000-4000-8000-000000000001', 'page_A1', (:'f'::jsonb->>'owner')::uuid, (:'f'::jsonb->>'owner')::uuid, null),
  ('a0000000-0000-4000-8000-000000000002', (:'f'::jsonb->>'ws')::uuid, 'a0000000-0000-4000-8000-000000000002', 'page_C',  (:'f'::jsonb->>'owner')::uuid, (:'f'::jsonb->>'owner')::uuid, (:'f'::jsonb->>'agent')::uuid),
  ('a0000000-0000-4000-8000-000000000003', (:'f'::jsonb->>'ws')::uuid, 'a0000000-0000-4000-8000-000000000003', 'page_D',  (:'f'::jsonb->>'owner')::uuid, (:'f'::jsonb->>'owner')::uuid, null);
insert into public.agent_activities (workspace_id, task_id, seq, type, body, author_type, author_id)
values ((:'f'::jsonb->>'ws')::uuid, 'a0000000-0000-4000-8000-000000000001', 1, 'prompt', '{"text":"start"}', 'human', (:'f'::jsonb->>'owner')::uuid);

-- authenticated
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select isnt(tests.sqlstate_of($$update public.agent_activities set body = '{}'$$), '', 'authenticated cannot update activities');
select isnt(tests.sqlstate_of($$delete from public.agent_activities$$), '', 'authenticated cannot delete activities');

-- service_role
select tests.reset_role();
select tests.set_service();
select isnt(tests.sqlstate_of($$update public.agent_activities set body = '{}'$$), '', 'service_role cannot update activities');
select isnt(tests.sqlstate_of($$delete from public.agent_activities$$), '', 'service_role cannot delete activities');

-- table owner
select tests.reset_role();
select is(tests.sqlstate_of($$update public.agent_activities set body = '{}'$$), 'PT403', 'the table owner cannot update activities');
select is(tests.sqlstate_of($$delete from public.agent_activities$$), 'PT403', 'the table owner cannot delete activities');

-- agent visibility of tasks
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select ok(exists (select 1 from public.agent_tasks where id = 'a0000000-0000-4000-8000-000000000001'), 'agent sees a task on a page it can read');
select ok(exists (select 1 from public.agent_tasks where id = 'a0000000-0000-4000-8000-000000000002'), 'agent sees a task delegated to it');
select ok(not exists (select 1 from public.agent_tasks where id = 'a0000000-0000-4000-8000-000000000003'), 'agent does not see other tasks');

select * from finish();
rollback;
