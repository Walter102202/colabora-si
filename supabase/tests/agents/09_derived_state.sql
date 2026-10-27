begin;
select plan(12);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A3', 'page_A');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"First"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t1 \gset
select public.create_agent_task('page_A2', '{"objective":"Second","done_when":[{"id":"c1","text":"Report written","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t2 \gset
select public.create_agent_task('page_A3', '{"objective":"Third"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t3 \gset

-- request_input: the run waits, the task waits on a person, the owner is notified.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t1'::uuid, 'custom') ->> 'run_id' as r1 \gset
select public.request_input(:'r1'::uuid, 'Which format?') ->> 'approval_id' as ap \gset
select tests.reset_role();
select is((select status from public.agent_runs where id = :'r1'::uuid), 'waiting', 'request_input puts the run in waiting');
select is((select state from public.agent_tasks where id = :'t1'::uuid), 'input_required', 'request_input puts the task in input_required');
select ok(exists (select 1 from public.notifications where task_id = :'t1'::uuid and kind = 'input_required'), 'the owner gets an input_required notification');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap'::uuid, 'respond', '{"text":"Markdown"}'::jsonb);

-- A response does not change state; an unrecoverable error ends the run and requeues the task.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.post_activity(:'r1'::uuid, 'response', '{"text":"Partial result"}'::jsonb) ->> 'task_state', 'working', 'a response keeps the task working');
select public.post_activity(:'r1'::uuid, 'error', '{"code":"tool_failed","message":"boom","recoverable":false}'::jsonb);
select tests.reset_role();
select is((select status from public.agent_runs where id = :'r1'::uuid), 'error', 'an unrecoverable error ends the run');
select is((select state from public.agent_tasks where id = :'t1'::uuid), 'queued', 'a non-terminal error requeues the task');

-- A terminal error fails the task.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t1'::uuid, 'custom') ->> 'run_id' as r2 \gset
select public.post_activity(:'r2'::uuid, 'error', '{"code":"gone","message":"source deleted","recoverable":false,"terminal":true}'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'t1'::uuid), 'failed', 'a terminal error fails the task');

-- submit_for_review checks the done_when criteria.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t2'::uuid, 'custom') ->> 'run_id' as r3 \gset
select public.add_artifact(:'r3'::uuid, 'page', 'page_A2', 'Report', '{}') ->> 'artifact_id' as a1 \gset
select is(tests.error_of(format('select public.submit_for_review(%L::uuid, %L, array[%L::uuid])', :'r3', 'Done', :'a1')),
          'criteria_uncovered', 'submitting without covering the criteria is rejected');
select public.add_artifact(:'r3'::uuid, 'page', 'page_A2', 'Report', array['c1']) ->> 'artifact_id' as a2 \gset
select is(public.submit_for_review(:'r3'::uuid, 'Done', array[:'a2'::uuid]) ->> 'task_state', 'ready_for_review', 'covered criteria move the task to ready_for_review');

-- end_run(completed) without a delivery requeues the task.
select public.claim_task(:'t3'::uuid, 'custom') ->> 'run_id' as r4 \gset
select public.end_run(:'r4'::uuid, 'completed');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'t3'::uuid), 'queued', 'a run that ends without a delivery requeues the task');

-- A stop never acknowledged for more than 10 minutes is cancelled by housekeeping.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t3'::uuid, 'custom') ->> 'run_id' as r5 \gset
select tests.reset_role();
update public.agent_runs set stop_requested_at = now() - interval '11 minutes' where id = :'r5'::uuid;
select private.agent_housekeeping();
select is((select status from public.agent_runs where id = :'r5'::uuid), 'cancelled', 'housekeeping cancels the unacknowledged run');
select is((select state from public.agent_tasks where id = :'t3'::uuid), 'cancelled', 'housekeeping cancels its task');

select * from finish();
rollback;
