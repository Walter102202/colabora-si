begin;
select plan(4);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Costly work"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
-- call 1
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset

-- Hard budget for an agent whose cost the platform measures.
select tests.reset_role();
update public.agents set monthly_budget_usd = 1, capabilities = '{"cost": true}'::jsonb where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
-- call 2
select public.record_cost(:'run'::uuid, 1000, 1000, null, 2.5);
select tests.reset_role();
select ok((select stop_requested_at from public.agent_runs where id = :'run'::uuid) is not null, 'spending over the budget requests a stop');
select ok(exists (select 1 from public.notifications where kind = 'task_failed' and user_id = (:'f'::jsonb->>'owner')::uuid), 'the sponsor is notified');

-- New assignments to an agent over budget are refused.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid)', 'page_A2', '{"objective":"More"}', :'f'::jsonb->>'agent')),
          'PT402', 'assigning work to an agent over budget raises PT402');

-- Rate limit: 120 calls per minute; calls 3 to 120 succeed and call 121 raises PT429.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select count(public.heartbeat(:'run'::uuid)) from generate_series(1, 118);
select is(tests.sqlstate_of(format('select public.heartbeat(%L::uuid)', :'run')), 'PT429', 'call 121 is rate limited');

select * from finish();
rollback;
