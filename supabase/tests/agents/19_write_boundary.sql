begin;
select plan(5);

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

select * from finish();
rollback;
