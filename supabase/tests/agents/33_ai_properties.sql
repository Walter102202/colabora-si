-- AI properties: a person asks the property's agent to fill empty rows; the request is a task of its own that
-- does not take the page's task slot; the run writes only requested rows, with server-stamped provenance and one
-- revertable activity per row; a person's edit wins; the request closes itself once every row has a value.
begin;
select plan(54);

select tests.fixture() as f \gset
-- The fixture agent plays the workspace's platform agent and takes pushes.
update public.agents set is_platform = true, capabilities = '{"start":true}'::jsonb where id = (:'f'::jsonb->>'agent')::uuid;
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'db_L', null, jsonb_build_object('id', 'db_L', 'title', 'Leads', 'parentId', null,
  'blocks', '[]'::jsonb,
  'database', jsonb_build_object('id', 'd1',
    'properties', jsonb_build_array(
      jsonb_build_object('id', 'title', 'name', 'Name', 'type', 'text'),
      jsonb_build_object('id', 'p_notes', 'name', 'Notes', 'type', 'text'),
      jsonb_build_object('id', 'p_ai', 'name', 'Summary', 'type', 'ai', 'aiPrompt', 'Summarize the notes in five words')),
    'rows', jsonb_build_array(
      jsonb_build_object('id', 'r1', 'pageId', 'row_1', 'cells', jsonb_build_object('title', 'Acme', 'p_notes', 'Big client'), 'rev', 1),
      jsonb_build_object('id', 'r2', 'pageId', 'row_2', 'cells', jsonb_build_object('title', 'Beta', 'p_notes', 'Small'), 'rev', 1),
      jsonb_build_object('id', 'r3', 'pageId', 'row_3', 'cells', jsonb_build_object('title', 'Gamma',
        'p_ai', jsonb_build_object('text', 'Kept', 'by', 'human', 'id', 'someone', 'at', 1)), 'rev', 1)),
    'views', jsonb_build_array(jsonb_build_object('id', 'v1', 'type', 'table', 'name', 'Table')))));

-- A. Who may ask.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_ai')$$), 'humans_only', 'an agent cannot ask for a fill');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_ai')$$), 'forbidden', 'a viewer cannot ask for a fill');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of($$select public.request_ai_fill('db_L', 'p_ai')$$), '42501', 'a signed-out caller cannot call it');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_notes')$$), 'not_ai_property', 'only an AI property is filled');
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_ai', 'some')$$), 'invalid_input', 'the mode is empty or all');
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_ai', 'empty', array['nope'])$$), 'row_not_found',
          'an unknown row is refused');

-- B. The request.
select public.request_ai_fill('db_L', 'p_ai') as req \gset
select is((:'req'::jsonb->>'rows')::int, 2, 'mode empty asks for the two empty rows');
select tests.reset_role();
select is((select request_kind from public.agent_tasks where id = (:'req'::jsonb->>'task_id')::uuid), 'fill', 'the request is a fill task');
select is((select request->'row_ids' from public.agent_tasks where id = (:'req'::jsonb->>'task_id')::uuid), '["r1", "r2"]'::jsonb,
          'it names the rows in table order');
select is((select delegate_agent_id from public.agent_tasks where id = (:'req'::jsonb->>'task_id')::uuid), (:'f'::jsonb->>'agent')::uuid,
          'the platform agent fills it by default');
select ok(exists (select 1 from public.agent_events where task_id = (:'req'::jsonb->>'task_id')::uuid and type = 'task.start'),
          'the agent is told to start');
select ok(private.agent_has_grant((:'f'::jsonb->>'agent')::uuid, 'db_L', 'write'), 'the agent may write the database page');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_ai', 'all')$$), 'request_in_progress', 'one open fill per database');
select public.create_agent_task('db_L', '{"objective":"Clean the leads"}'::jsonb) ->> 'task_id' as work \gset
select ok(:'work' is not null, 'a work task still fits on the page while the fill is open');
select tests.reset_role();

-- C. The fill run.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task((:'req'::jsonb->>'task_id')::uuid, 'custom') ->> 'run_id' as run \gset
select tests.reset_role();
update public.agent_runs set stop_requested_at = now() where id = :'run'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.set_ai_cells(%L::uuid, '[{"row_id":"r1","text":"Too late"}]'::jsonb)$$, :'run')), 'stop_requested', 'a stopped fill cannot write cells');
select is(tests.error_of(format('select public.complete_ai_request(%L::uuid)', :'run')), 'stop_requested', 'a stopped fill cannot complete');
select tests.reset_role();
update public.agent_runs set stop_requested_at = null where id = :'run'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.set_ai_cells(%L::uuid, '[{"row_id":"r3","text":"x"}]'::jsonb)$$, :'run')),
          'row_not_requested', 'a row outside the request is refused');
select is(tests.error_of(format($$select public.set_ai_cells(%L::uuid, '[{"row_id":"r1"}]'::jsonb)$$, :'run')), 'invalid_input',
          'a value needs text or an error');
select public.set_ai_cells(:'run'::uuid, '[{"row_id":"r1","text":"Large account, renewal due","rev":1}]'::jsonb, 'fill-1') as w1 \gset
select is(jsonb_array_length(:'w1'::jsonb->'written'), 1, 'the value is written');
select tests.reset_role();
select is((select r->'cells'->'p_ai'->>'text' from public.pages p, jsonb_array_elements(p.data->'database'->'rows') r
            where p.id = 'db_L' and r->>'id' = 'r1'), 'Large account, renewal due', 'the cell holds the text');
select is((select r->'cells'->'p_ai'->>'runId' from public.pages p, jsonb_array_elements(p.data->'database'->'rows') r
            where p.id = 'db_L' and r->>'id' = 'r1'), :'run', 'the server stamps the run');
select is((select r->'cells'->'p_ai'->>'by' from public.pages p, jsonb_array_elements(p.data->'database'->'rows') r
            where p.id = 'db_L' and r->>'id' = 'r1'), 'agent', 'and who wrote it');
select ok(exists (select 1 from public.agent_activities where run_id = :'run'::uuid and body->>'op' = 'set_cells'
                   and body->>'row_id' = 'r1' and inverse_ops is not null), 'each written row leaves an activity with its inverse');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.set_ai_cells(:'run'::uuid, '[{"row_id":"r1","text":"Another text"}]'::jsonb, 'fill-1'), :'w1'::jsonb,
          'the idempotency key answers a repeat with the first result');
select is(public.set_ai_cells(:'run'::uuid, '[{"row_id":"r2","text":"Small","rev":0}]'::jsonb) -> 'conflicts' -> 0 ->> 'row_id', 'r2',
          'a stale rev is a conflict, not a write');
select is(tests.error_of(format('select public.complete_ai_request(%L::uuid)', :'run')), 'request_incomplete',
          'the request does not close with a row left');
select tests.reset_role();
-- A person writes r2 while the run works.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('db_L', jsonb_build_array(jsonb_build_object('op', 'db_cell_set', 'rowId', 'r2', 'propertyId', 'p_ai',
  'value', jsonb_build_object('text', 'Small, local', 'by', 'human', 'id', :'f'::jsonb->>'owner',
                              'at', floor(extract(epoch from clock_timestamp()) * 1000)::bigint))));
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.set_ai_cells(:'run'::uuid, '[{"row_id":"r2","text":"Tiny"}]'::jsonb) -> 'skipped' -> 0 ->> 'reason', 'edited_by_person',
          'a person''s edit after the request wins');
select is(public.complete_ai_request(:'run'::uuid, 'Filled one row',
            '{"input_tokens":1200,"output_tokens":80,"model":"muse-spark-1.3"}'::jsonb) -> 'counts',
          '{"filled":1,"failed":0,"by_person":1,"deleted":0}'::jsonb, 'complete counts what each row got');
select tests.reset_role();
select is((select state || '/' || acceptance from public.agent_tasks where id = (:'req'::jsonb->>'task_id')::uuid), 'done/accepted',
          'the request closes itself as done and accepted');
select is((select closed_by from public.agent_tasks where id = (:'req'::jsonb->>'task_id')::uuid), null::uuid, 'no person closed it');
select is((select status from public.agent_runs where id = :'run'::uuid), 'completed', 'the run completed');
select ok((select cost_usd from public.agent_runs where id = :'run'::uuid) > 0, 'its cost is recorded');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.set_ai_cells(%L::uuid, '[{"row_id":"r1","text":"x"}]'::jsonb)$$, :'run')),
          'run_not_active', 'nothing writes after the request closed');
select tests.reset_role();

-- D. Undoing a fill.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.revert_run(:'run'::uuid, array['row:db_L:r1']) -> 'reverted', '["row:db_L:r1"]'::jsonb, 'revert_run undoes a filled row');
select tests.reset_role();
select is((select r->'cells'->'p_ai' from public.pages p, jsonb_array_elements(p.data->'database'->'rows') r
            where p.id = 'db_L' and r->>'id' = 'r1'), 'null'::jsonb, 'the cell is empty again');

-- E. Failure, generic writes, limits and the agent that fills.
-- Clearing a cell is a person's edit too, including when the model reads it only after the clear.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.request_ai_fill('db_L', 'p_ai', 'all', array['r3']) ->> 'task_id' as clear_req \gset
select public.apply_page_ops('db_L', '[{"op":"db_cell_set","rowId":"r3","propertyId":"p_ai","value":null}]'::jsonb);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'clear_req'::uuid, 'custom') ->> 'run_id' as clear_run \gset
select is(public.set_ai_cells(:'clear_run'::uuid, '[{"row_id":"r3","text":"Overwrite"}]'::jsonb)->'skipped',
  '[{"row_id":"r3","reason":"edited_by_person"}]'::jsonb, 'clearing a cell after the request wins over the model');
select is(public.complete_ai_request(:'clear_run'::uuid)->'counts'->>'by_person', '1', 'a cleared cell closes the request as a person edit');
select tests.reset_role();

-- A client's clock can lag the server: the snapshot, not its timestamp, proves a new human edit.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('db_L', '[{"op":"db_cell_set","rowId":"r3","propertyId":"p_ai","value":{"text":"Before","by":"human","id":"person","at":1}},{"op":"db_cell_set","rowId":"r1","propertyId":"p_ai","value":{"text":"Unchanged","by":"human","id":"person","at":1}}]'::jsonb);
select public.request_ai_fill('db_L', 'p_ai', 'all', array['r1','r3']) ->> 'task_id' as clock_req \gset
select public.apply_page_ops('db_L', '[{"op":"db_cell_set","rowId":"r3","propertyId":"p_ai","value":{"text":"Mine with a lagging clock","by":"human","id":"person","at":1}}]'::jsonb);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'clock_req'::uuid, 'custom') ->> 'run_id' as clock_run \gset
select public.set_ai_cells(:'clock_run'::uuid, '[{"row_id":"r1","text":"Regenerated"},{"row_id":"r3","text":"Overwrite"}]'::jsonb) as clock_write \gset
select is(:'clock_write'::jsonb->'skipped', '[{"row_id":"r3","reason":"edited_by_person"}]'::jsonb, 'a new human edit wins even with a lagging clock');
select is(:'clock_write'::jsonb->'written'->0->>'row_id', 'r1', 'an unchanged pre-request human value can still be regenerated');
select is(public.complete_ai_request(:'clock_run'::uuid)->'counts'->>'by_person', '1', 'completion counts the human edit without trusting its clock');
select tests.reset_role();

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.request_ai_fill('db_L', 'p_ai', 'all') ->> 'task_id' as req2 \gset
select is((select jsonb_array_length(request->'row_ids') from public.agent_tasks where id = :'req2'::uuid), 3, 'mode all asks for every row');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'req2'::uuid, 'custom') ->> 'run_id' as run2 \gset
select public.end_run(:'run2'::uuid, 'error', 'model unavailable', null, true);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'req2'::uuid), 'failed', 'a fill that fails ends failed');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of($$select public.set_row_cells('db_L', 'r1', '{"p_ai":{"text":"sneaky"}}'::jsonb)$$), 'invalid_cell',
          'update_row cannot write an AI cell');
select public.claim_task(:'work'::uuid, 'custom') ->> 'run_id' as run_work \gset
select is(tests.error_of(format('select public.complete_ai_request(%L::uuid)', :'run_work')), 'not_a_request_run',
          'a work run cannot complete itself as a request');
select tests.reset_role();
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'db_big', null, jsonb_build_object('id', 'db_big', 'title', 'Big', 'parentId', null,
  'blocks', '[]'::jsonb,
  'database', jsonb_build_object('id', 'd2',
    'properties', jsonb_build_array(jsonb_build_object('id', 'title', 'name', 'Name', 'type', 'text'),
      jsonb_build_object('id', 'p_ai', 'name', 'Tag', 'type', 'ai', 'aiPrompt', 'One tag')),
    'rows', (select jsonb_agg(jsonb_build_object('id', 'b' || i, 'pageId', 'bp' || i, 'cells', '{}'::jsonb, 'rev', 1) order by i)
               from generate_series(1, 60) i),
    'views', '[]'::jsonb)));
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.request_ai_fill('db_big', 'p_ai') - 'task_id', '{"rows":50,"remaining":10}'::jsonb,
          'a fill takes 50 rows and says how many remain');
select tests.reset_role();
-- Requests without an available worker expire, while a recent heartbeat preserves live work.
update public.agent_tasks set updated_at = now() - interval '16 minutes', created_at = now() - interval '16 minutes'
 where row_page_id = 'db_big' and request_kind = 'fill';
select private.agent_housekeeping();
select is((select state from public.agent_tasks where row_page_id = 'db_big' and request_kind = 'fill'), 'failed', 'an unclaimed request expires after fifteen minutes');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.request_ai_fill('db_big', 'p_ai') ->> 'task_id' as retry_fill \gset
select ok(:'retry_fill' is not null, 'expiry releases the fill slot');
select public.send_agent_message(:'retry_fill'::uuid, 'Cancel AI request', 'stop');
select is((select state from public.agent_tasks where id = :'retry_fill'::uuid), 'cancelled', 'a person can cancel an unclaimed request immediately');
select public.request_ai_fill('db_big', 'p_ai') ->> 'task_id' as idle_fill \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'idle_fill'::uuid) ->> 'run_id' as idle_run \gset
select tests.reset_role();
update public.agent_tasks set created_at = now() - interval '16 minutes', updated_at = now() - interval '16 minutes' where id = :'idle_fill'::uuid;
update public.agent_runs set last_signal_at = now() - interval '16 minutes' where id = :'idle_run'::uuid;
select private.agent_housekeeping();
select is((select t.state || '/' || r.status from public.agent_tasks t join public.agent_runs r on r.task_id = t.id where r.id = :'idle_run'::uuid), 'failed/error', 'an abandoned request closes its run and task');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.request_ai_fill('db_big', 'p_ai') ->> 'task_id' as live_fill \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'live_fill'::uuid);
select tests.reset_role();
update public.agent_tasks set created_at = now() - interval '16 minutes', updated_at = now() - interval '16 minutes' where id = :'live_fill'::uuid;
select private.agent_housekeeping();
select is((select state from public.agent_tasks where id = :'live_fill'::uuid), 'working', 'a recent heartbeat keeps a request alive');
select is((select state from public.agent_tasks where id = :'work'::uuid), 'working', 'ordinary work is unaffected by request expiry');

select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'open@agents.invalid', 'worker', 'page_A') as other \gset
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('db_L', jsonb_build_array(jsonb_build_object('op', 'db_prop_set', 'property',
  jsonb_build_object('id', 'p_ai', 'name', 'Summary', 'type', 'ai', 'aiPrompt', 'Summarize the notes in five words',
                     'aiAgentId', :'other'::jsonb->>'agent'))));
select public.request_ai_fill('db_L', 'p_ai', 'all') ->> 'task_id' as req3 \gset
select tests.reset_role();
select is((select delegate_agent_id from public.agent_tasks where id = :'req3'::uuid), (:'other'::jsonb->>'agent')::uuid,
          'the property names the agent that fills it');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('db_L', jsonb_build_array(jsonb_build_object('op', 'db_prop_set', 'property',
  jsonb_build_object('id', 'p_ai', 'name', 'Summary', 'type', 'ai', 'aiPrompt', 'Summarize', 'aiAgentId', 'not-an-agent'))));
select is(tests.error_of($$select public.request_ai_fill('db_L', 'p_ai', 'all')$$), 'delegate_not_found',
          'an agent outside the workspace cannot fill');
select tests.reset_role();
update public.agents set is_platform = false where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of($$select public.request_ai_fill('db_big', 'p_ai')$$), 'delegate_not_found',
          'without a platform agent nobody fills by default');
select tests.reset_role();

select * from finish();
rollback;
