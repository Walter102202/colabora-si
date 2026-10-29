begin;
select plan(18);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
-- One row with 201 cells exercises several inverse operations per selected item.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_DB', 'page_A', jsonb_build_object(
  'id', 'page_DB', 'title', 'Cells', 'blocks', '[]'::jsonb, 'database', jsonb_build_object('id', 'db', 'views', '[]'::jsonb,
    'properties', (select jsonb_agg(jsonb_build_object('id', 'p' || i, 'name', 'P' || i, 'type', 'number')) from generate_series(1, 201) i),
    'rows', jsonb_build_array(jsonb_build_object('id', 'row1', 'rev', 1, 'cells',
      (select jsonb_object_agg('p' || i, 0) from generate_series(1, 201) i))))));
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Write three paragraphs","policies":{"preapproved":["test_effect"]}}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset

-- The agent appends three blocks on the row page, edits a block a person wrote on page_A and appends one block on page_A2.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'codex') ->> 'run_id' as run \gset
select public.append_page_blocks('page_A1', '[{"type":"paragraph","spans":["Alpha"]},{"type":"paragraph","spans":["Beta"]},{"type":"paragraph","spans":["Gamma"]}]'::jsonb) as w \gset
select :'w'::jsonb->'block_ids'->>0 as b1, :'w'::jsonb->'block_ids'->>1 as b2, :'w'::jsonb->'block_ids'->>2 as b3 \gset
select public.edit_block_text('page_A', 'blk_a1', 'Hello A', 'Intermediate');
select public.update_block('page_A', 'blk_a1', '{"checked":true}'::jsonb);
select public.edit_block_text('page_A', 'blk_a1', 'Intermediate', 'Hello from the agent');
select public.append_page_blocks('page_A2', '[{"type":"paragraph","spans":["Delta"]}]'::jsonb) -> 'block_ids' ->> 0 as b4 \gset
select public.set_row_cells('page_DB', 'row1', (select jsonb_object_agg('p' || i, jsonb_build_object('number', 1)) from generate_series(1, 100) i));
select public.set_row_cells('page_DB', 'row1', (select jsonb_object_agg('p' || i, jsonb_build_object('number', 1)) from generate_series(101, 201) i));
select public.begin_external_op(:'run'::uuid, 'stub', 'test_effect', '{}'::jsonb)->>'op_id' as external_op \gset
select public.finish_external_op(:'external_op'::uuid, 'done', 'local-test');
select tests.reset_role();
select is((select (body->'after_revs'->>'blk_a1')::int from public.agent_activities where task_id = :'task'::uuid and body->>'op' = 'edit_block' order by seq limit 1), 2,
          'a write records after_revs for the block it touched');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A1:' || :'b1'])), 'run_active',
          'revert_run on an active run is run_active');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A1:' || :'b1'])), 'humans_only',
          'an agent cannot call revert_run');
select public.end_run(:'run'::uuid, 'completed');

-- After the run: a person edits Beta and deletes Gamma; an old-style activity has no after_revs.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('page_A1', format('[{"op":"update_block","id":"%s","patch":{"html":"Beta by a person"}}]', :'b2')::jsonb);
select public.apply_page_ops('page_A1', format('[{"op":"delete_block","id":"%s"}]', :'b3')::jsonb);
select tests.reset_role();
insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, inverse_ops, author_type, author_id)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, :'run'::uuid, private.next_seq(:'task'::uuid), 'action',
        '{"op":"edit_block","page_id":"page_A","block_ids":["blk_old"],"summary":"Edited before 0019"}'::jsonb,
        '[{"op":"update_block","id":"blk_old","patch":{"html":"old"}}]'::jsonb, 'agent', (:'f'::jsonb->>'agent')::uuid);

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.task_diff(:'task'::uuid) as d \gset
select tests.reset_role();
select is((select x->>'status' || '/' || (x->>'change') from jsonb_array_elements(:'d'::jsonb->'runs'->0->'items') x where x->>'key' = 'block:page_A1:' || :'b1'),
          'revertable/added', 'task_diff lists an appended block as added and revertable');
select is((select (x->>'before_text') || ' -> ' || (x->>'after_text') from jsonb_array_elements(:'d'::jsonb->'runs'->0->'items') x where x->>'key' = 'block:page_A:blk_a1'),
          'Hello A -> Hello from the agent', 'task_diff lists an edited block with its text before and after');
select is((select x->>'status' from jsonb_array_elements(:'d'::jsonb->'runs'->0->'items') x where x->>'key' = 'block:page_A1:' || :'b2'),
          'changed_since', 'a block a person edited after the run is changed_since');
select is((select x->>'status' from jsonb_array_elements(:'d'::jsonb->'runs'->0->'items') x where x->>'key' = 'block:page_A1:' || :'b3'),
          'gone', 'a block a person deleted after the run is gone');
select ok((select x->>'status' from jsonb_array_elements(:'d'::jsonb->'runs'->0->'items') x where x->>'key' = 'block:page_A:blk_old') = 'manual'
          and (select x->>'status' from jsonb_array_elements(:'d'::jsonb->'runs'->0->'items') x where x->>'key' = 'external:' || :'external_op') = 'manual',
          'an activity without after_revs and an external effect without inverses are manual');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A1:nope'])), 'item_not_found',
          'revert_run with an unknown key is item_not_found');
select tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A1:' || :'b1', 'block:page_A1:' || :'b2'])) as conflict_error \gset
select tests.reset_role();
select ok(:'conflict_error' = 'revert_conflict'
          and private.block_path((select data from public.pages where id = 'page_A1'), :'b1') is not null,
          'revert_run with a block changed since is revert_conflict and changes nothing');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A1:' || :'b1'])), 'forbidden',
          'a viewer cannot revert');

-- The page checks of private.pw_page also hold for revert_run.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('page_A', '[{"op":"set_page","patch":{"locked":true}}]'::jsonb);
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A:blk_a1'])), 'page_locked',
          'revert_run on a locked page is page_locked');
select public.apply_page_ops('page_A', '[{"op":"set_page","patch":{"locked":false}}]'::jsonb);
update public.pages set deleted_at = now() where id = 'page_A2';
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A2:' || :'b4'])), 'not_found',
          'revert_run on a page in the trash is not_found');

select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revert_run(:'run'::uuid, array['block:page_A1:' || :'b1', 'block:page_A:blk_a1', 'row:page_DB:row1', 'block:page_A1:' || :'b1']) as rv \gset
select tests.reset_role();
select ok(private.block_path((select data from public.pages where id = 'page_A1'), :'b1') is null
          and (select data #>> (private.block_path(data, 'blk_a1') || array['html']) from public.pages where id = 'page_A') = 'Hello A'
          and (select data #> (private.block_path(data, 'blk_a1') || array['checked']) from public.pages where id = 'page_A') = 'null'::jsonb
          and (select bool_and(value = '0'::jsonb) from public.pages p, lateral jsonb_each(p.data->'database'->'rows'->0->'cells') where p.id = 'page_DB')
          and jsonb_array_length(:'rv'::jsonb->'reverted') = 3,
          'revert_run deletes the added block, merges the oldest inverse fields and restores 201 cells once per key');
select results_eq(format($q$ select author_type, body->>'op', inverse_ops is not null from public.agent_activities where id = %L::uuid $q$, :'rv'::jsonb->>'activity_id'),
                  $q$ values ('human'::text, 'revert_run'::text, true) $q$, 'the revert is recorded as a person''s action with its inverse');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.revert_run(%L::uuid, %L::text[])', :'run', array['block:page_A:blk_a1'])), 'revert_conflict',
          'reverting the same key again is revert_conflict');
select is((select x->>'status' from jsonb_array_elements(public.task_diff(:'task'::uuid)->'runs'->0->'items') x where x->>'key' = 'block:page_A:blk_a1'),
          'reverted', 'after the revert the diff marks the item as reverted');

-- The delegate agent loses its grant: it still sees the task, but items on pages it cannot read are only counted.
select tests.reset_role();
update public.agent_grants set revoked_at = now() where id = (:'f'::jsonb->>'grant')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.task_diff(:'task'::uuid) as d2 \gset
select tests.reset_role();
select ok(:'d2'::jsonb->'runs'->0->'items' = '[]'::jsonb and (:'d2'::jsonb->>'hidden_items')::int = 8,
          'items on pages the caller cannot read are only counted (hidden_items)');

select * from finish();
rollback;
