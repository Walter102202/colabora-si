begin;
select plan(5);

select tests.fixture() as f \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Long work"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset

select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.send_agent_message(:'task'::uuid, 'Stop, please', 'stop') ->> 'delivery', 'stop_requested', 'stop with an active run asks the run to stop');
select tests.reset_role();
select ok((select stop_requested_at from public.agent_runs where id = :'run'::uuid) is not null, 'the run has stop_requested_at');
select is((select state from public.agent_tasks where id = :'task'::uuid), 'working', 'the task keeps its state until the stop is acknowledged');

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.ack_stop(:'run'::uuid);
select tests.reset_role();
select is((select status from public.agent_runs where id = :'run'::uuid), 'cancelled', 'ack_stop cancels the run');
select is((select state from public.agent_tasks where id = :'task'::uuid), 'cancelled', 'ack_stop cancels the task');

select * from finish();
rollback;
