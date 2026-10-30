-- Inline AI rewrite: a person asks the platform agent to rewrite a text block; the request has its own slot; the
-- answer is text spans only, written with the run's attribution and an inverse; it closes the request; revert_run
-- undoes it.
begin;
select plan(30);

select tests.fixture() as f \gset
update public.agents set is_platform = true, capabilities = '{"start":true}'::jsonb where id = (:'f'::jsonb->>'agent')::uuid;
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M', null, jsonb_build_object('id', 'page_M', 'title', 'Mixed', 'parentId', null,
  'blocks', jsonb_build_array(
    jsonb_build_object('id', 'blk_m', 'type', 'paragraph', 'indent', 0, 'rev', 1,
      'html', '<span class="mention person-mention" data-user="' || (:'f'::jsonb->>'owner') || '">@owner</span> please check'),
    jsonb_build_object('id', 'blk_c', 'type', 'code', 'indent', 0, 'rev', 1, 'html', 'select 1'),
    jsonb_build_object('id', 'blk_l', 'type', 'paragraph', 'indent', 0, 'rev', 1, 'html', repeat('a', 5001)))));

-- A. Who may ask, and for which block.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of($$select public.request_ai_rewrite('page_A', 'blk_a1', 'Make it formal')$$), 'humans_only',
          'an agent cannot ask for a rewrite');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of($$select public.request_ai_rewrite('page_A', 'blk_a1', 'Make it formal')$$), 'forbidden',
          'a viewer cannot ask for a rewrite');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of($$select public.request_ai_rewrite('page_A', 'blk_a1', 'Make it formal')$$), '42501',
          'a signed-out caller cannot call it');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of($$select public.request_ai_rewrite('page_A', 'blk_a1', '  ')$$), 'invalid_input', 'an instruction is required');
select is(tests.error_of($$select public.request_ai_rewrite('page_M', 'blk_c', 'Shorter')$$), 'not_text_block', 'a code block is refused');
select is(tests.error_of($$select public.request_ai_rewrite('page_M', 'blk_m', 'Shorter')$$), 'block_has_mentions',
          'a block with a mention is refused');
select is(tests.error_of($$select public.request_ai_rewrite('page_M', 'blk_l', 'Shorter')$$), 'block_too_long',
          'a block over 5000 characters is refused');
select is(tests.error_of($$select public.request_ai_rewrite('page_A', 'nope', 'Shorter')$$), 'block_not_found', 'an unknown block is refused');

-- B. The request.
select public.request_ai_rewrite('page_A', 'blk_a1', 'Make it formal', 'Hello') ->> 'task_id' as req \gset
select tests.reset_role();
select is((select request_kind || ':' || (request->>'block_id') from public.agent_tasks where id = :'req'::uuid), 'rewrite:blk_a1',
          'the request names the block');
select is((select delegate_agent_id from public.agent_tasks where id = :'req'::uuid), (:'f'::jsonb->>'agent')::uuid,
          'the platform agent rewrites');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of($$select public.request_ai_rewrite('page_A', 'blk_a1', 'Shorter')$$), 'request_in_progress',
          'one open rewrite per page');
select public.create_agent_task('page_A', '{"objective":"Write the intro"}'::jsonb) ->> 'task_id' as work \gset
select ok(:'work' is not null, 'a work task still fits on the page');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select count(*) from public.agent_tasks where id = :'req'::uuid), 1::bigint, 'members see the request like any task');
select tests.reset_role();

-- C. The answer.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'req'::uuid, 'custom') ->> 'run_id' as run \gset
select tests.reset_role();
update public.agent_runs set stop_requested_at = now() where id = :'run'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.apply_ai_rewrite(%L::uuid, '["Too late"]'::jsonb)$$, :'run')), 'stop_requested', 'a stopped rewrite cannot replace the block');
select tests.reset_role();
update public.agent_runs set stop_requested_at = null where id = :'run'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.apply_ai_rewrite(%L::uuid, '[{"mention":"page","pageId":"page_B"}]'::jsonb)$$, :'run')),
          'invalid_input', 'the answer holds text spans only');
select is(tests.sqlstate_of(format($$select public.apply_ai_rewrite(%L::uuid, '["Greetings"]'::jsonb, 0)$$, :'run')), 'PT409',
          'a stale rev is a block conflict');
select tests.reset_role();
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'other@agents.invalid', 'worker', 'page_A') as other \gset
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.apply_ai_rewrite(%L::uuid, '["Greetings"]'::jsonb)$$, :'run')), 'forbidden',
          'another agent cannot answer for the run');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.apply_ai_rewrite(:'run'::uuid, '["Greetings, ", {"text":"A","bold":true}]'::jsonb, 1,
            '{"input_tokens":300,"output_tokens":20,"model":"muse-spark-1.3"}'::jsonb) ->> 'rev', '2', 'the answer is written');
select tests.reset_role();
select is((select data #>> '{blocks,0,html}' from public.pages where id = 'page_A'), 'Greetings, <strong>A</strong>',
          'the block holds the escaped answer');
select is((select data #>> '{blocks,0,attr,runId}' from public.pages where id = 'page_A'), :'run', 'the block is attributed to the run');
select ok(exists (select 1 from public.agent_activities where run_id = :'run'::uuid and body->>'op' = 'edit_block'
                   and body->'block_ids' ? 'blk_a1' and inverse_ops is not null), 'the write leaves an activity with its inverse');
select is((select state || '/' || acceptance from public.agent_tasks where id = :'req'::uuid), 'done/accepted', 'the answer closes the request');
select is((select status from public.agent_runs where id = :'run'::uuid), 'completed', 'and completes the run');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.apply_ai_rewrite(%L::uuid, '["Again"]'::jsonb)$$, :'run')), 'run_not_active',
          'a second answer is refused');
select tests.reset_role();

update public.agent_tasks set state = 'done' where id = :'req'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'req', 'Continue', 'continue')), 'task_closed', 'a done AI request cannot reopen');
select tests.reset_role();
update public.agent_tasks set state = 'failed' where id = :'req'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'req', 'Continue', 'continue')), 'task_closed', 'a failed AI request cannot reopen');
select tests.reset_role();
update public.agent_tasks set state = 'cancelled' where id = :'req'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'req', 'Continue', 'continue')), 'task_closed', 'a cancelled AI request cannot reopen');
select tests.reset_role();
update public.agent_tasks set state = 'done' where id = :'req'::uuid;

-- D. Undo, and runs that are not rewrites.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revert_run(:'run'::uuid, array['block:page_A:blk_a1']);
select tests.reset_role();
select is((select data #>> '{blocks,0,html}' from public.pages where id = 'page_A'), 'Hello A', 'revert_run restores the text');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.request_ai_rewrite('page_A', 'blk_a1', 'Shorter') ->> 'task_id' as req2 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'req2'::uuid, 'custom') ->> 'run_id' as run2 \gset
select is(tests.error_of(format('select public.complete_ai_request(%L::uuid)', :'run2')), 'not_a_request_run',
          'complete_ai_request does not close a rewrite');
select public.claim_task(:'work'::uuid, 'custom') ->> 'run_id' as run_work \gset
select is(tests.error_of(format($$select public.apply_ai_rewrite(%L::uuid, '["x"]'::jsonb)$$, :'run_work')), 'not_a_request_run',
          'a work run cannot answer a rewrite');
select tests.reset_role();

select * from finish();
rollback;
