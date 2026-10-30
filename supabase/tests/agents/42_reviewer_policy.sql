begin;
select plan(19);
select tests.fixture() as f \gset
-- A real database page: the review task gets its own row, as a task a Lead creates by hand does.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_DB', 'page_A', jsonb_build_object('id', 'page_DB', 'title', 'Tasks', 'parentId', 'page_A', 'blocks', '[]'::jsonb,
  'database', jsonb_build_object('properties', jsonb_build_array(
      jsonb_build_object('id', 'title', 'name', 'Task', 'type', 'text'),
      jsonb_build_object('id', 'run', 'name', 'Run', 'type', 'id', 'idPrefix', 'RUN', 'nextId', 1)),
    'rows', '[]'::jsonb, 'views', '[]'::jsonb)));
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_DB') from unnest(array['page_P','page_S','page_N']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+revlead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+rev@agents.invalid', 'worker', 'page_B') as rev \gset
-- The worker can write its own row and nothing else: it cannot add rows to the database by itself.
delete from public.agent_grants where agent_id = (:'f'::jsonb->>'agent')::uuid;
select tests.reset_role();

-- 1-3. Shapes refused when the brief is written.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid)', 'page_P', '{"objective":"x","policies":{"reviewer_agent_id":"nope"}}', :'lead'::jsonb->>'agent')), 'invalid_input', 'a reviewer is an agent id');
select is(tests.error_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid)', 'page_P', '{"objective":"x","policies":{"lease_minutes":5}}', :'lead'::jsonb->>'agent')), 'invalid_input', 'a lease has a floor');
select is(tests.error_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid)', 'page_P', '{"objective":"x","policies":{"lease_minutes":"60"}}', :'lead'::jsonb->>'agent')), 'invalid_input', 'a lease is a number');

select public.create_agent_task('page_P', format('{"objective":"Parent","policies":{"reviewer_agent_id":"%s"}}', :'rev'::jsonb->>'agent')::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.create_agent_task('page_S', '{"objective":"Sub","done_when":[{"id":"c1","text":"Works","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as sub \gset
select public.create_agent_task('page_N', '{"objective":"Worker is the reviewer","done_when":[{"id":"c1","text":"Works","check":"lead"}]}'::jsonb,
                                (:'rev'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as self \gset
select tests.reset_role();

-- 4-11. A delivery opens the review task.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as run \gset
select public.add_artifact(:'run'::uuid, 'page', 'page_S', 'Notes', array['c1']) ->> 'artifact_id' as art \gset
select public.submit_for_review(:'run'::uuid, 'done', array[:'art'::uuid]) ->> 'review_task_id' as rt \gset
select tests.reset_role();
select isnt(:'rt'::text, ''::text, 'the delivery opens a review task');
select is((select parent_task_id::text from public.agent_tasks where id = :'rt'::uuid), :'parent', 'on the same parent');
select is((select delegate_agent_id::text from public.agent_tasks where id = :'rt'::uuid), :'rev'::jsonb->>'agent', 'delegated to the reviewer');
select is((select b.policies->>'review_of' from public.task_briefs b where b.task_id = :'rt'::uuid), :'sub', 'naming the delivery');
select is((select p.parent_id from public.agent_tasks t join public.pages p on p.id = t.row_page_id where t.id = :'rt'::uuid), 'page_DB', 'with its own row in the database');
select is((select data->'blocks'->0->>'key' from public.agent_tasks t join public.pages p on p.id = t.row_page_id where t.id = :'rt'::uuid), 'brief:goal', 'and the brief in its page');
select is((select payload->>'review_task_id' from public.agent_events where task_id = :'parent'::uuid and type = 'task.continue' order by created_at desc limit 1), :'rt', 'the Lead learns a reviewer has it');
select is((select type from public.agent_events where task_id = :'rt'::uuid and type = 'task.start' limit 1), null, 'no start event for a reviewer without the start capability');

-- 12-14. The reviewer reads the delivery and records the review; nothing else was granted.
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.claim_task(:'rt'::uuid, 'claude_code') ->> 'run_id' as rr \gset
select is((select count(*)::int from public.agent_artifacts where task_id = :'sub'::uuid), 1, 'the reviewer reads the artifact of the delivery');
select is((public.review_task(:'sub'::uuid, 'changes_requested', '[{"criterion_id":"c1","status":"contradicted","note":"npm test fails"}]'::jsonb, '[]'::jsonb, null, :'rr'::uuid))->>'task_state', 'queued', 'the reviewer sends it back');
select is((select state from public.agent_tasks where id = :'rt'::uuid), 'done', 'recording it closes the review task');
select tests.reset_role();

-- 15-16. Round two: a new review task that only confirms what was asked for.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as run2 \gset
select public.submit_for_review(:'run2'::uuid, 'fixed', array[:'art'::uuid]) ->> 'review_task_id' as rt2 \gset
select tests.reset_role();
select isnt(:'rt2'::text, :'rt'::text, 'each delivery has its review task');
select ok((select constraints from public.task_briefs where task_id = :'rt2'::uuid) like '%round 2%npm test fails%', 'the second review only confirms the open findings');

-- 17. A second open review of the same delivery is not created.
select is((select count(*)::int from public.agent_tasks t join public.task_briefs b on b.task_id = t.id
            where t.parent_task_id = :'parent'::uuid and b.policies->>'review_of' = :'sub' and t.state <> 'done'), 1, 'one open review per delivery');

-- 18. Nobody reviews their own delivery: the Lead keeps it.
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.claim_task(:'self'::uuid, 'claude_code') ->> 'run_id' as sr \gset
select public.add_artifact(:'sr'::uuid, 'page', 'page_N', 'Notes', array['c1']) ->> 'artifact_id' as sart \gset
select is((public.submit_for_review(:'sr'::uuid, 'done', array[:'sart'::uuid]))->>'review_task_id', null, 'the reviewer does not review itself');
select tests.reset_role();

-- 19. A disabled reviewer never blocks a delivery.
update public.agents set status = 'disabled' where id = (:'rev'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.review_task(:'sub'::uuid, 'approved', '[]'::jsonb, '[]'::jsonb) from (select 1 where false) x;
select tests.reset_role();
update public.agent_tasks set state = 'working', active_run_id = :'run2'::uuid, review_state = 'none' where id = :'sub'::uuid;
update public.agent_runs set status = 'running', ended_at = null where id = :'run2'::uuid;
update public.agent_tasks set state = 'cancelled' where id = :'rt2'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((public.submit_for_review(:'run2'::uuid, 'again', array[:'art'::uuid]))->>'task_state', 'ready_for_review', 'a disabled reviewer never blocks a delivery');
select tests.reset_role();

select * from finish();
rollback;
