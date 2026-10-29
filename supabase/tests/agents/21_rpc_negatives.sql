-- Negative cases for the agent-layer RPCs that had no test: a principal without the right gets the documented code.
begin;
select plan(26);

select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+other@agents.invalid', 'worker', 'page_B') as other \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_DB_B', 'page_B', '{
  "id":"page_DB_B","title":"Hidden leads","parentId":"page_B","blocks":[],
  "database":{"id":"dbB","views":[],"properties":[{"id":"title","name":"Name","type":"text"}],"rows":[]}}'::jsonb);

-- A task and a run owned by the fixture agent.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Email the summary","policies":{"preapproved":["send_email"]}}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset
select public.begin_external_op(:'run'::uuid, 'smtp', 'send_email', '{"to":"a@b.test"}'::jsonb) as op \gset
select is(tests.error_of(format('select public.begin_external_op(%L::uuid, %L, %L, %L::jsonb)', :'run', 'smtp', 'send_email', '[]')), 'invalid_input',
          'begin_external_op rejects params that are not an object');

-- begin_external_op / finish_external_op / touch_run_wait: a person is not an agent.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.begin_external_op(%L::uuid, %L, %L, %L::jsonb)', :'run', 'smtp', 'send_email', '{}')), 'agent_disabled',
          'a person cannot begin an external op');
select is(tests.error_of(format('select public.touch_run_wait(%L::uuid, %L::uuid)', :'run', :'task')), 'agent_disabled',
          'a person cannot touch a run wait');
select is(tests.error_of('select public.mark_events_delivered()'), 'agent_disabled', 'a person cannot mark agent events delivered');

-- Another agent on a run it does not own.
select tests.reset_role();
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.begin_external_op(%L::uuid, %L, %L, %L::jsonb)', :'run', 'smtp', 'send_email', '{}')), 'forbidden',
          'another agent cannot begin an external op on a foreign run');
select is(tests.error_of(format('select public.finish_external_op(%L::uuid, %L, %L)', :'op'::jsonb->>'op_id', 'done', 'ref-1')), 'forbidden',
          'another agent cannot finish a foreign external op');
select is(tests.error_of(format('select public.touch_run_wait(%L::uuid, %L::uuid)', :'run', :'task')), 'forbidden',
          'another agent cannot touch a foreign run wait');

-- The owner of the run: wrong inputs.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.finish_external_op(%L::uuid, %L, %L)', gen_random_uuid(), 'done', 'ref-1')), 'not_found',
          'finishing an unknown op is not_found');
select is(tests.error_of(format('select public.finish_external_op(%L::uuid, %L, %L)', :'op'::jsonb->>'op_id', 'maybe', 'ref-1')), 'invalid_input',
          'finish_external_op rejects an unknown status');
select is(tests.error_of(format('select public.touch_run_wait(%L::uuid, %L::uuid)', :'run', gen_random_uuid())), 'not_found',
          'touch_run_wait rejects an unknown task');
select is(public.mark_events_delivered(), '[]'::jsonb, 'the owning agent may mark its events delivered (none pending)');

-- update_agent / add_agent_member / revoke_agent_grant: agents and viewers.
select is(tests.error_of(format('select public.update_agent(%L::uuid, %L::jsonb)', :'f'::jsonb->>'agent', '{"name":"x"}')), 'humans_only',
          'an agent cannot update an agent');
select is(tests.error_of(format('select public.add_agent_member(%L::uuid)', :'f'::jsonb->>'agent')), 'humans_only',
          'an agent cannot add an agent as member');
select is(tests.error_of(format('select public.revoke_agent_grant(%L::uuid)', :'f'::jsonb->>'grant')), 'humans_only',
          'an agent cannot revoke a grant');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format('select public.update_agent(%L::uuid, %L::jsonb)', :'f'::jsonb->>'agent', '{"name":"x"}')), 'forbidden',
          'a viewer cannot update an agent');
select is(tests.error_of(format('select public.add_agent_member(%L::uuid)', :'f'::jsonb->>'agent')), 'forbidden',
          'a viewer cannot add an agent as member');
select is(tests.error_of(format('select public.revoke_agent_grant(%L::uuid)', :'f'::jsonb->>'grant')), 'forbidden',
          'a viewer cannot revoke a grant');
select is(tests.error_of(format('select public.add_row(%L, %L::jsonb)', 'page_DB_B', '{"Name":{"text":"x"}}')), 'forbidden',
          'a viewer cannot add a row');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.update_agent(%L::uuid, %L::jsonb)', :'f'::jsonb->>'agent', '{"role":"lead"}')), 'field_not_allowed',
          'update_agent rejects a field outside the allowed list');
select is(tests.error_of(format('select public.update_agent(%L::uuid, %L::jsonb)', :'f'::jsonb->>'agent', '{"status":"disabled"}')), 'invalid_state',
          'update_agent rejects status disabled');
select is(tests.error_of(format('select public.revoke_agent_grant(%L::uuid)', gen_random_uuid())), 'not_found',
          'revoking an unknown grant is not_found');

-- add_row: the fixture agent has no grant on page_B.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.add_row(%L, %L::jsonb)', 'page_DB_B', '{"Name":{"text":"x"}}')), 'forbidden',
          'an agent without a grant cannot add a row');
select is(tests.error_of(format('select public.add_row(%L, %L::jsonb)', 'page_A', '{}')), 'not_a_database',
          'add_row on a plain page is not_a_database');

-- service_role-only functions.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format('select public.agent_dispatch_config(%L::uuid)', :'f'::jsonb->>'agent')), '42501', 'authenticated cannot read dispatch secrets');
select is(tests.sqlstate_of('select public.agent_token_config()'), '42501', 'authenticated cannot read the token pepper');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of('select public.agent_token_config()'), '42501', 'anon cannot read the token pepper');

select * from finish();
rollback;
