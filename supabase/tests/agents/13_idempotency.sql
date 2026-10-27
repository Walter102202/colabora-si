begin;
select plan(8);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_DB', 'page_A', '{
  "id":"page_DB","title":"Leads","parentId":"page_A","blocks":[],
  "database":{"id":"db1","views":[],
    "properties":[{"id":"title","name":"Name","type":"text"},{"id":"f1","name":"Score","type":"formula","formula":"1"}],
    "rows":[{"id":"r1","pageId":"page_A1","cells":{"title":"First"}}]}}'::jsonb);

-- The same idempotency key twice: one insert, the same response.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.append_page_blocks('page_A', '[{"type":"paragraph","spans":["ab and ab"]}]'::jsonb, null, 'key-1') as first \gset
select public.append_page_blocks('page_A', '[{"type":"paragraph","spans":["ab and ab"]}]'::jsonb, null, 'key-1') as second \gset
select is(:'second'::jsonb, :'first'::jsonb, 'a repeated key returns the first response');
select tests.reset_role();
select is((select jsonb_array_length(data->'blocks') from public.pages where id = 'page_A'), 2, 'a repeated key inserts once');

-- old_str must appear exactly once.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(format('select public.edit_block_text(%L, %L, %L, %L)', 'page_A', :'first'::jsonb->'block_ids'->>0, 'ab', 'cd')),
          'PT422', 'a repeated old_str raises PT422');
select is(tests.error_of(format('select public.edit_block_text(%L, %L, %L, %L)', 'page_A', :'first'::jsonb->'block_ids'->>0, 'ab', 'cd')),
          'old_str_not_unique', 'the error is old_str_not_unique');

-- A person edits blk_a1 (rev 1 -> 2); the agent then writes with the rev it read and gets the current text.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.edit_block_text('page_A', 'blk_a1', 'Hello A', 'Hello from a person');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of($$select public.edit_block_text('page_A', 'blk_a1', 'Hello', 'Hi', 1)$$), 'block_conflict',
          'a stale rev from an agent raises block_conflict');
select is((tests.detail_of($$select public.edit_block_text('page_A', 'blk_a1', 'Hello', 'Hi', 1)$$))::jsonb ->> 'text',
          'Hello from a person', 'the conflict detail carries the current text');
select is(tests.error_of($$select public.edit_block_text('page_A', 'blk_a1', 'gone text', 'Hi', 1)$$), 'block_conflict',
          'a stale rev is a conflict even when old_str is no longer in the block');

-- Computed properties cannot be written.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of($$select public.set_row_cells('page_DB', 'r1', '{"Score":{"number":3}}'::jsonb)$$), 'computed_property',
          'writing a formula cell raises computed_property');

select * from finish();
rollback;
