begin;
select plan(22);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_P','page_1','page_2','page_3']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+envlead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_user('env-stranger@test.local') as stranger \gset
select tests.reset_role();

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_P', '{"objective":"Parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.create_agent_task('page_1', '{"objective":"One"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as one \gset
select public.create_agent_task('page_2', '{"objective":"Two"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as two \gset
select tests.reset_role();

-- 1-2. Only the Lead of the parent or a person with edit rights reserves.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[{"kind":"stack","value":"x"}]')), 'forbidden', 'a worker cannot reserve');
select is(tests.error_of(format('select public.release_environment(%L::uuid)', :'one')), 'forbidden', 'a worker cannot release');
select tests.reset_role();
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[{"kind":"stack","value":"x"}]')), 'forbidden', 'a stranger cannot reserve');
select is(tests.error_of(format('select public.release_environment(%L::uuid)', :'one')), 'forbidden', 'a stranger cannot release');
select tests.reset_role();

-- 3-7. Shapes.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid,'claude_code');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[]')), 'invalid_input', 'an empty list is refused');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[{"kind":"gpu","value":"x"}]')), 'invalid_input', 'an unknown kind is refused');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[{"kind":"ports","value":"60950-60940"}]')), 'invalid_input', 'a backwards range is refused');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[{"kind":"ports","value":"70000-70001"}]')), 'invalid_input', 'a port out of range is refused');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'one', '[{"kind":"migration","value":"31"}]')), 'invalid_input', 'a migration number has four digits');

-- 8-12. Reservation: atomic, repeatable, exclusive, overlapping ranges included.
select jsonb_array_length(public.reserve_environment(:'one'::uuid,
  '[{"kind":"ports","value":"60940-60949"},{"kind":"stack","value":"colabora-si-a"},{"kind":"migration","value":"0031"},{"kind":"worktree","value":"C:/dev/a"}]'::jsonb)) as n \gset
select is(:'n'::int, 4, 'four resources are held');
select is(jsonb_array_length(public.reserve_environment(:'one'::uuid, '[{"kind":"stack","value":"colabora-si-a"}]'::jsonb)), 4, 'reserving again what the task holds changes nothing');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'two', '[{"kind":"ports","value":"60945-60955"}]')), 'resource_taken', 'an overlapping range is refused');
select ok(tests.detail_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'two', '[{"kind":"migration","value":"0031"}]')) like '%' || :'one' || '%', 'the refusal names the task that holds it');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid, %L::jsonb)', :'two', '[{"kind":"branch","value":"a/two"},{"kind":"stack","value":"colabora-si-a"}]')), 'resource_taken', 'one taken item refuses the list');
select is((select count(*)::int from public.agent_resources where task_id = :'two'::uuid), 0, 'and nothing of that list stays held');

-- 14. The worker sees its environment.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*)::int from public.agent_resources where task_id = :'one'::uuid), 4, 'the worker reads its environment');
select is(tests.sqlstate_of(format('insert into public.agent_resources (workspace_id, task_id, kind, value, created_by) values (%L, %L, %L, %L, %L)',
  :'f'::jsonb->>'ws', :'two', 'stack', 'mine', :'f'::jsonb->>'agent_user')), '42501', 'nobody writes the table directly');
select tests.reset_role();
select tests.set_human(:'stranger'::uuid);
select is((select count(*)::int from public.agent_resources), 0, 'a stranger reads nothing');
select tests.reset_role();

-- 17-19. The task ends: migration numbers are back, the rest waits for the Lead, and the Lead is told what to stop.
update public.agent_tasks set state = 'cancelled' where id = :'one'::uuid and state <> 'cancelled';
select is((select status from public.agent_resources where task_id = :'one'::uuid and kind = 'migration'), 'released', 'the migration number is free at once');
select is((select count(*)::int from public.agent_resources where task_id = :'one'::uuid and status = 'releasing'), 3, 'the others wait for confirmation');
select is((select jsonb_array_length(payload->'environment_release') from public.agent_events
            where task_id = :'parent'::uuid and type = 'task.updated' and payload ? 'environment_release' order by created_at desc limit 1), 3, 'the Lead is told what to stop');

-- 20. Confirmed, the ports can be taken again.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.release_environment(:'one'::uuid);
select is(jsonb_array_length(public.reserve_environment(:'two'::uuid, '[{"kind":"ports","value":"60945-60955"}]'::jsonb)), 1, 'released ports can be reserved again');
select tests.reset_role();

select * from finish();
rollback;
