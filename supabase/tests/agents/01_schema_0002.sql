begin;
select plan(17);

select has_table('public', 'agents', 'agents table exists');
select has_table('public', 'agent_grants', 'agent_grants table exists');
select has_table('public', 'agent_tokens', 'agent_tokens table exists');
select has_table('public', 'agent_oauth_links', 'agent_oauth_links table exists');
select has_view('public', 'agent_tokens_safe', 'agent_tokens_safe view exists');
select has_function('private', 'current_agent_id', 'current_agent_id exists');
select has_function('private', 'jwt_client_id', 'jwt_client_id exists');
select has_function('private', 'linked_agent_id', 'linked_agent_id exists');
select has_function('private', 'task_actor_agent_id', 'task_actor_agent_id exists');
select has_function('private', 'agent_can', array['text', 'text'], 'agent_can exists');
select has_function('private', 'check_rate', array['uuid'], 'check_rate exists');
select has_function('public', 'whoami', 'whoami exists');

-- Fixture + principal switching
select tests.fixture() as f \gset
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);

select is(private.agent_can_read('page_A'), true, 'agent reads page_A through the plug');
select is(private.agent_can_read('page_A1'), true, 'agent reads child page_A1 through inherit');
select is(private.agent_can_write('page_B'), false, 'agent cannot write page_B');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(private.agent_can('page_A', 'read'), false, 'a human principal never matches agent_can');

-- Rate limit: the 121st call in the same minute raises PT429 (check_rate is only callable from RPC bodies; exercised as the owner role here).
select tests.reset_role();
select private.check_rate((:'f'::jsonb->>'agent')::uuid) from generate_series(1, 120);
select is(tests.sqlstate_of(format('select private.check_rate(%L::uuid)', :'f'::jsonb->>'agent')), 'PT429', 'call 121 is rate limited');

select * from finish();
rollback;
