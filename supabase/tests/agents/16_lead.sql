begin;
select plan(7);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset

-- The Lead takes the parent task and delegates a subtask to the worker.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Ship the report"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A2', '{"objective":"Write the report"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset

-- Round 1: the worker delivers, the Lead asks for changes.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A2', 'Report', '{}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'art'::uuid]);

select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L)', :'sub', 'approved')), 'forbidden',
          'review_task outside a run of the Lead on the parent is refused');
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid) as rv1 \gset
select is(:'rv1'::jsonb ->> 'rounds', '1', 'the first review counts one round');
select is(:'rv1'::jsonb ->> 'task_state', 'queued', 'the subtask goes back to the queue');

-- Rounds 2 and 3.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w2 \gset
select public.submit_for_review(:'w2'::uuid, 'v2', array[:'art'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w3 \gset
select public.submit_for_review(:'w3'::uuid, 'v3', array[:'art'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);

-- The third request for changes escalates to a person.
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'input_required', 'the third round escalates');
select is((select waiting_on from public.agent_tasks where id = :'sub'::uuid), 'human', 'the escalation waits on a person');
select ok(exists (select 1 from public.notifications where task_id = :'sub'::uuid and kind = 'escalation'), 'the owner gets an escalation notification');
select is((select review_rounds from public.agent_tasks where id = :'sub'::uuid), 3, 'three rounds were counted');

select * from finish();
rollback;
