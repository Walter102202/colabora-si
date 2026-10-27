begin;
select plan(4);

select tests.fixture() as f \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Summarize page A"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset

select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(null, 'claude_code') ->> 'run_id' as run \gset
select ok(:'run' is not null, 'claim_task without id takes the queued task');
select is(public.claim_task(null, 'codex') ->> 'task_id', null, 'nothing else is queued: task_id is null');

-- The task waits on a person while its run stays active.
select public.request_input(:'run'::uuid, 'Which section first?');
select is(tests.sqlstate_of(format('select public.claim_task(%L::uuid, %L)', :'task', 'codex')), 'PT409', 'claiming a task with an active run raises PT409');
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'task', 'codex')), 'run_active', 'the error is run_active');

select * from finish();
rollback;
