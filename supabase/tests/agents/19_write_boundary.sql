begin;
select plan(17);

select tests.fixture() as f \gset

-- 1. An agent with a write grant cannot use apply_page_ops: the partial RPCs are the only way in.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of($$select public.apply_page_ops('page_A', '[{"op":"update_block","id":"blk_a1","rev":1,"patch":{"html":"Agent edit"}}]'::jsonb)$$),
          'PT403', 'apply_page_ops from an agent raises PT403');
select is(tests.error_of($$select public.apply_page_ops('page_A', '[{"op":"update_block","id":"blk_a1","rev":1,"patch":{"html":"Agent edit"}}]'::jsonb)$$),
          'use_partial_writes', 'the error is use_partial_writes');
select tests.reset_role();
select is((select data#>>'{blocks,0,html}' from public.pages where id = 'page_A'), 'Hello A', 'the refused call leaves the page intact');

-- 2. The same agent writes the same block through edit_block_text (the boundary does not close legitimate writes).
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.edit_block_text('page_A', 'blk_a1', 'Hello A', 'Hello from the agent', 1);
select tests.reset_role();
select is((select data#>>'{blocks,0,html}' from public.pages where id = 'page_A'), 'Hello from the agent', 'edit_block_text still writes for the agent');
select is((select data#>>'{blocks,0,rev}' from public.pages where id = 'page_A'), '2', 'the block rev advances');

-- 3. A done task cannot be claimed by an agent; only a person reopens it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Finish once"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'codex') ->> 'run_id' as run \gset
select public.add_artifact(:'run'::uuid, 'page', 'page_A1', 'Result', '{}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'run'::uuid, 'Done', array[:'art'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'task'::uuid, 'accepted');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'done', 'the person closed the task');

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(format('select public.claim_task(%L::uuid, %L)', :'task', 'codex')), 'PT409', 'claiming a done task raises PT409');
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'task', 'codex')), 'task_unavailable', 'the error is task_unavailable');
select is(public.claim_task(null, 'codex') ->> 'task_id', null, 'claim without id skips the done task');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'done', 'the refused claims leave the task done');

-- 4. A person reopens the done task with Continue: it goes back to the queue.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.send_agent_message(:'task'::uuid, 'One more pass', 'continue') ->> 'delivery', 'queued_for_next_session', 'a person may reopen a done task');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'queued', 'the reopened task is queued');
select ok((select acceptance = 'pending' and closed_at is null from public.agent_tasks where id = :'task'::uuid), 'reopening clears acceptance and closed_at');

-- 5. A Lead cannot reopen a closed subtask: reopening is a decision of a person.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A3', 'page_A');
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A2', '{"objective":"Lead parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A3', '{"objective":"Write the report"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A3', 'Report', '{}') ->> 'artifact_id' as sart \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'sart'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'sub'::uuid, 'accepted');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'sub', 'Redo it', 'continue')), 'PT409', 'a Lead continuing a done subtask raises PT409');
select is(tests.error_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'sub', 'Redo it', 'continue')), 'task_closed', 'the error is task_closed');
select is(tests.error_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'sub', 'Not good', 'feedback')), 'task_closed', 'feedback from a Lead on a done subtask is task_closed too');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'done', 'the subtask stays done');

select * from finish();
rollback;
