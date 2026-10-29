begin;
select plan(10);

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

select * from finish();
rollback;
