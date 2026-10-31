begin;
select plan(21);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A2','page_A3','page_A4','page_A5','page_A6','page_A7']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+reviewer@agents.invalid', 'worker', 'page_A') as rev \gset

-- Parent led by the Lead; its policy lets the Lead (and so the reviewer) close subtasks.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Ship the report","policies":{"subtask_close":"lead"}}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A2', '{"objective":"Write the report","done_when":[{"id":"c1","text":"Report written","check":"lead"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset

-- The worker delivers.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A2', 'Report', '{c1}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'art'::uuid]);

-- The Lead delegates the review task to the reviewer.
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.create_subtask(:'parent'::uuid, 'page_A3',
  format('{"objective":"Review the report against its done_when","done_when":[{"id":"r1","text":"One finding per criterion","check":"lead"}],"sources":[{"kind":"page","ref":"page_A2"}],"policies":{"review_of":"%s"}}', :'sub')::jsonb,
  (:'rev'::jsonb->>'agent')::uuid) ->> 'task_id' as rtask \gset

-- 1. A worker without review_of is still refused.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'approved', '[{"criterion_id":"c1","status":"verified"}]', '[]', :'w1')),
          'forbidden', 'an agent without a review task cannot review');

-- 2. The reviewer is refused until it holds an active run on its review task.
select tests.reset_role();
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, null)', :'sub', 'approved', '[{"criterion_id":"c1","status":"verified"}]', '[]')),
          'forbidden', 'the reviewer without an active run on its review task is refused');

-- 3-4. A task that names review_of but is not a subtask of the same parent grants nothing (security: only the
-- parent's Lead can delegate a review). The owner creates a top-level task on page_A4 for the reviewer.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A4', format('{"objective":"Rogue review","policies":{"review_of":"%s"}}', :'sub')::jsonb, (:'rev'::jsonb->>'agent')::uuid) ->> 'task_id' as rogue \gset
select tests.reset_role();
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.claim_task(:'rogue'::uuid, 'reference-agent') ->> 'run_id' as rg \gset
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'approved', '[{"criterion_id":"c1","status":"verified"}]', '[]', :'rg')),
          'forbidden', 'a top-level task naming review_of is not a review task');
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'sub')), 'lead_only', 'nor does it let the agent close the subtask');
select public.end_run(:'rg'::uuid, 'completed');

-- 5-9. From its run on the real review task the reviewer reviews (run_id may be omitted: reviewer_run_of resolves it).
select public.claim_task(:'rtask'::uuid, 'reference-agent') ->> 'run_id' as rr \gset
select public.review_task(:'sub'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified","note":"Report present"}]'::jsonb,
                          '[{"kind":"page","ref":"page_A2"}]'::jsonb, null, :'rr'::uuid) as rv \gset
select is((select reviewer_id::text from public.agent_reviews where id = (:'rv'::jsonb->>'review_id')::uuid), :'rev'::jsonb->>'agent', 'the review is authored by the reviewer');
select is((select run_id::text from public.agent_reviews where id = (:'rv'::jsonb->>'review_id')::uuid), :'rr', 'the review carries the reviewer run');
select tests.reset_role();
select is((select state || '/' || acceptance from public.agent_tasks where id = :'rtask'::uuid), 'done/accepted', 'recording the review closes the review task');
select is((select status from public.agent_runs where id = :'rr'::uuid), 'running', 'the reviewer run remains until end_run or housekeeping');
select ok(exists (select 1 from public.agent_activities where task_id = :'rtask'::uuid and type = 'response' and body->>'review_of' = :'sub'), 'the review task logs the review');
select ok(exists (select 1 from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated' and payload->>'subtask_id' = :'rtask' and payload->>'subtask_state' = 'done'),
          'the Lead is told that the review task closed');
-- The review task is done: its still-active run may not submit it (submit_for_review is guarded by task state since 0018).
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.add_artifact(:'rr'::uuid, 'page', 'page_A3', 'Stray', '{r1}') ->> 'artifact_id' as stray \gset
select is(tests.error_of(format('select public.submit_for_review(%L::uuid, %L, array[%L::uuid])', :'rr', 'Stray', :'stray')), 'invalid_state',
          'the reviewer run cannot submit its closed review task');
select tests.reset_role();

-- Closing the review task ends its authority; the Lead closes the delivery by policy.
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'sub')),'lead_only','a closed review task cannot authorize closure');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.close_subtask(:'sub'::uuid);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'done', 'the Lead closes the reviewed subtask by policy');
select ok(exists (select 1 from public.agent_activities where task_id = :'sub'::uuid and body->>'text' = 'Closed by the lead.'), 'the closing activity names the Lead');
select is((select payload->>'closed_by' from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated' and payload->>'subtask_id' = :'sub' order by seq desc limit 1),
          'lead', 'the close event names the Lead');

-- 12-14. Once its review run ended, the reviewer is refused like any worker (lead_only comes before invalid_state,
-- 0009:163-167); only the Lead gets invalid_state.
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select is((public.end_run(:'rr'::uuid, 'completed') ->> 'task_state'), 'done', 'ending the reviewer run leaves the review task done');
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'sub')), 'lead_only', 'a reviewer whose review run ended is refused like any worker');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'sub')), 'invalid_state', 'nothing to close twice, even for the Lead');

-- 15-17. Without a closing policy the reviewer closes only by a verified deterministic check (0006:194-210):
-- a review with the criterion verified and evidence whose ref equals the command.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A5', '{"objective":"Checked parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent2 \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent2'::uuid, 'claude_code') ->> 'run_id' as lr2 \gset
select public.create_subtask(:'parent2'::uuid, 'page_A6', '{"objective":"Make the tests pass","done_when":[{"id":"d1","text":"Tests pass","check":"deterministic","command":"npm test"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub2 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub2'::uuid, 'codex') ->> 'run_id' as w2 \gset
select public.add_artifact(:'w2'::uuid, 'page', 'page_A6', 'Green build', '{d1}') ->> 'artifact_id' as art2 \gset
select public.submit_for_review(:'w2'::uuid, 'v1', array[:'art2'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.create_subtask(:'parent2'::uuid, 'page_A7',
  format('{"objective":"Review the build","done_when":[{"id":"r1","text":"One finding per criterion","check":"lead"}],"sources":[{"kind":"page","ref":"page_A6"}],"policies":{"review_of":"%s"}}', :'sub2')::jsonb,
  (:'rev'::jsonb->>'agent')::uuid) ->> 'task_id' as rtask2 \gset
select tests.reset_role();
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.claim_task(:'rtask2'::uuid, 'reference-agent') ->> 'run_id' as rr2 \gset
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'sub2')), 'policy_denied', 'no policy and no verified check: the reviewer cannot close');
select public.review_task(:'sub2'::uuid, 'approved', '[{"criterion_id":"d1","status":"verified","note":"npm test green"}]'::jsonb,
                          '[{"kind":"capture","ref":"npm test"}]'::jsonb, null, :'rr2'::uuid);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.close_subtask(:'sub2'::uuid, 'accepted', '[{"kind":"capture","ref":"npm test"}]'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub2'::uuid), 'done', 'the Lead closes by the independent verified deterministic check');
select is((select body->>'rule' from public.agent_activities where task_id = :'sub2'::uuid and body->>'text' = 'Closed by the lead.'), 'deterministic', 'the closing activity records the deterministic rule');

select * from finish();
rollback;
