begin;
select plan(22);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A2','page_A3','page_A4','page_A5','page_A6']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+reviewer@agents.invalid', 'worker', 'page_A') as rev \gset

-- A parent led by the Lead and a subtask the worker delivers.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Ship the report"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A2', '{"objective":"Write the report","done_when":[{"id":"c1","text":"Report written","check":"lead"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A2', 'Report', '{c1}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'art'::uuid]);

-- 1-2. Negatives: the worker cannot review its own subtask, and an unknown verdict is refused.
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'blocked', '[]', '[]', :'w1')),
          'forbidden', 'the worker cannot block its own subtask');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'rejected', '[]', '[]', :'lr')),
          'invalid_input', 'a verdict outside approved, changes_requested and blocked is refused');

-- 3-10. The Lead blocks from its run on the parent: the subtask waits on a person, the review keeps the verdict.
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'blocked',
          '[{"criterion_id":"c1","status":"unverified","note":"Which fiscal year?"}]', '[]', :'lr')), '', 'the Lead can block a subtask');
select tests.reset_role();
select is((select state || '/' || waiting_on from public.agent_tasks where id = :'sub'::uuid), 'input_required/human', 'a blocked subtask waits on a person');
select is((select review_state from public.agent_tasks where id = :'sub'::uuid), 'none', 'no review verdict stays in effect on the task');
select is((select review_rounds from public.agent_tasks where id = :'sub'::uuid), 0, 'blocking does not count a review round');
select is((select verdict || '/' || reviewer_type from public.agent_reviews where task_id = :'sub'::uuid order by created_at desc limit 1), 'blocked/agent',
          'the review row records the blocked verdict of the Lead');
select ok(exists (select 1 from public.notifications where task_id = :'sub'::uuid and kind = 'input_required' and payload->>'blocked' = 'true'
                   and user_id = (:'f'::jsonb->>'owner')::uuid), 'the owner is asked for a decision');
select ok(not exists (select 1 from public.agent_events where task_id = :'sub'::uuid and type = 'task.feedback'), 'the worker gets no feedback to act on');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'blocked', '[]', '[]', :'lr')),
          'invalid_state', 'a blocked subtask is not in review any more');

-- 11-12. The answer of the person requeues the blocked subtask and the worker takes it again.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'sub'::uuid, 'Use fiscal year 2025.', 'feedback');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'queued', 'the answer of the person requeues the subtask');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.claim_task(:'sub'::uuid, 'codex') ->> 'task_id', :'sub', 'then the worker claims it');

-- 13-18. The reviewer agent blocks from its run on the review task: the review task closes, the Lead hears the verdict.
select public.add_artifact((select active_run_id from public.agent_tasks where id = :'sub'::uuid), 'page', 'page_A2', 'Report v2', '{c1}') ->> 'artifact_id' as art2 \gset
select public.submit_for_review((select active_run_id from public.agent_tasks where id = :'sub'::uuid), 'v2', array[:'art2'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select tests.make_review_subtask(:'parent'::uuid, 'page_A3',
  format('{"objective":"Review the report","done_when":[{"id":"r1","text":"One finding per criterion","check":"lead"}],"policies":{"review_of":"%s"}}', :'sub')::jsonb,
  (:'rev'::jsonb->>'agent')::uuid) ->> 'task_id' as rtask \gset
select tests.reset_role();
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.claim_task(:'rtask'::uuid, 'reference-agent') ->> 'run_id' as rr \gset
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'blocked',
          '[{"criterion_id":"c1","status":"contradicted","note":"The two sources disagree"}]', '[]', :'rr')), '', 'the reviewer agent can block the subtask');
select tests.reset_role();
select is((select state || '/' || waiting_on || '/' || review_state from public.agent_tasks where id = :'sub'::uuid), 'input_required/human/none',
          'the subtask blocked by the reviewer waits on a person');
select ok(exists (select 1 from public.agent_reviews where task_id = :'sub'::uuid and run_id = :'rr'::uuid and verdict = 'blocked'), 'the review carries the reviewer run');
select is((select state || '/' || acceptance from public.agent_tasks where id = :'rtask'::uuid), 'done/accepted', 'recording the blocked review closes the review task');
select is((select payload->>'verdict' from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated' and payload->>'subtask_id' = :'rtask'),
          'blocked', 'the Lead learns that the review blocked');
select is((select count(*)::int from public.notifications where task_id = :'sub'::uuid and kind = 'input_required' and payload->>'blocked' = 'true'), 2,
          'the owner is asked again');

-- 19-22. A person taking the review (the row panel button) blocks a task with no Lead.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A4', '{"objective":"Draft the memo"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as solo \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'solo'::uuid, 'codex') ->> 'run_id' as w3 \gset
select public.add_artifact(:'w3'::uuid, 'page', 'page_A4', 'Memo', '{}') ->> 'artifact_id' as art3 \gset
select public.submit_for_review(:'w3'::uuid, 'v1', array[:'art3'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, %L::uuid)', :'solo', 'blocked', '[]', '[]', :'art3')),
          'forbidden', 'a viewer cannot block a task');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.review_task(:'solo'::uuid, 'blocked', '[]'::jsonb, '[]'::jsonb, :'art3'::uuid) ->> 'task_state', 'input_required', 'a person can block a task');
select tests.reset_role();
select is((select state || '/' || waiting_on || '/' || review_state from public.agent_tasks where id = :'solo'::uuid), 'input_required/human/none',
          'the task blocked by a person waits on a person');
select is((select verdict || '/' || reviewer_type from public.agent_reviews where task_id = :'solo'::uuid), 'blocked/human', 'the review row names the person');

select * from finish();
rollback;
