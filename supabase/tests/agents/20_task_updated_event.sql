begin;
select plan(8);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A3', 'page_A');
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset

-- The check constraint accepts the new type.
select ok((select pg_get_constraintdef(oid) from pg_constraint where conname = 'agent_events_type_check') like '%task.updated%',
          'agent_events_type_check lists task.updated');

-- Lead takes the parent (policy: the lead may close subtasks) and delegates two subtasks to the worker.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Ship the report","policies":{"subtask_close":"lead"}}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A2', '{"objective":"Write the report"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub1 \gset
select public.create_subtask(:'parent'::uuid, 'page_A3', '{"objective":"Write the appendix"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub2 \gset

-- Worker delivers both.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub1'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A2', 'Report', '{}') ->> 'artifact_id' as a1 \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'a1'::uuid]);
select public.claim_task(:'sub2'::uuid, 'codex') ->> 'run_id' as w2 \gset
select public.add_artifact(:'w2'::uuid, 'page', 'page_A3', 'Appendix', '{}') ->> 'artifact_id' as a2 \gset
select public.submit_for_review(:'w2'::uuid, 'v1', array[:'a2'::uuid]);

-- A person closes sub1: the parent's delegate gets task.updated.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'sub1'::uuid, 'accepted', 'Good');
select tests.reset_role();
select is((select count(*)::int from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated'), 1,
          'close_task on a subtask queues one task.updated on the parent');
select is((select agent_id from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated'), (:'lead'::jsonb->>'agent')::uuid,
          'the event is addressed to the parent delegate');
select is((select payload from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated'),
          jsonb_build_object('subtask_id', :'sub1'::uuid, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', 'human'),
          'the payload names the subtask, its state, the acceptance and who closed it');

-- The lead closes sub2 by policy: a second task.updated, closed_by lead.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.close_subtask(:'sub2'::uuid);
select is((select count(*)::int from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated'), 2,
          'close_subtask queues a second task.updated');
select is((select payload->>'closed_by' from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated'
            and payload->>'subtask_id' = :'sub2'), 'lead', 'the lead closure is marked closed_by lead');

-- RLS: the lead reads its events, the worker does not.
select is((select count(*)::int from public.agent_events where type = 'task.updated'), 2, 'the lead reads both events under RLS');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*)::int from public.agent_events where type = 'task.updated'), 0, 'the worker reads none of the parent events');

select * from finish();
rollback;
