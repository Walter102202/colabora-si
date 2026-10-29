begin;
select plan(15);
select has_column('public', 'agents', 'is_platform', 'agents.is_platform exists');
select has_index('public', 'agents', 'agents_platform_per_workspace_uidx', 'one platform agent per workspace index exists');
select tests.fixture() as f \gset
select tests.make_user('agent+platform@agents.invalid') as pu \gset
select tests.make_user('agent+platform2@agents.invalid') as pu2 \gset

-- service_role only
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format('select public.ensure_platform_agent(%L::uuid, %L::uuid, %L::uuid)', :'f'::jsonb->>'ws', :'f'::jsonb->>'owner', :'pu')),
          '42501', 'authenticated cannot call ensure_platform_agent');
select tests.reset_role();
select tests.set_service();
select is(tests.sqlstate_of(format('select public.ensure_platform_agent(%L::uuid, %L::uuid, %L::uuid)', :'f'::jsonb->>'ws', :'f'::jsonb->>'viewer', :'pu')),
          'PT403', 'a viewer cannot enable the platform agent');
-- A member with the owner role is not the workspace owner (workspaces.owner_id) and is refused too.
select tests.make_user('coowner@test.local') as co \gset
insert into public.workspace_members (workspace_id, user_id, role) values ((:'f'::jsonb->>'ws')::uuid, :'co'::uuid, 'owner');
select is(tests.sqlstate_of(format('select public.ensure_platform_agent(%L::uuid, %L::uuid, %L::uuid)', :'f'::jsonb->>'ws', :'co', :'pu')),
          'PT403', 'a member with the owner role who is not workspaces.owner_id cannot enable the platform agent');

-- first call creates
select public.ensure_platform_agent((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, :'pu'::uuid) as r1 \gset
select is(:'r1'::jsonb ->> 'created', 'true', 'first call creates the agent');
select is((select count(*)::int from public.agents where workspace_id = (:'f'::jsonb->>'ws')::uuid and is_platform), 1, 'one platform row');
select results_eq(format($$ select name, kind, role, monthly_budget_usd::text, capabilities->>'cost', sponsor_user_id::text from public.agents where id = %L::uuid $$, :'r1'::jsonb->>'agent_id'),
          format($$ values ('Colabora', 'managed', 'lead', '20.0000', 'true', %L) $$, :'f'::jsonb->>'owner'), 'platform row has the agreed values');

-- second call returns the same row and creates nothing
select public.ensure_platform_agent((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, :'pu2'::uuid) as r2 \gset
select is(:'r2'::jsonb ->> 'created', 'false', 'second call is idempotent');
select is(:'r2'::jsonb ->> 'agent_id', :'r1'::jsonb ->> 'agent_id', 'second call returns the same agent');
select is((select count(*)::int from public.agents where workspace_id = (:'f'::jsonb->>'ws')::uuid and is_platform), 1, 'still one platform row');

-- the index refuses a second platform row
select tests.reset_role();
select is(tests.sqlstate_of(format($$ insert into public.agents (workspace_id, auth_user_id, name, kind, role, sponsor_user_id, created_by, is_platform)
   values (%L::uuid, %L::uuid, 'Dup', 'managed', 'lead', %L::uuid, %L::uuid, true) $$, :'f'::jsonb->>'ws', :'pu2', :'f'::jsonb->>'owner', :'f'::jsonb->>'owner')),
          '23505', 'a second platform row per workspace is rejected by the index');

-- no grants: the platform agent reads nothing
select tests.set_agent(:'pu'::uuid, (:'r1'::jsonb->>'agent_id')::uuid);
select is((select count(*)::int from public.pages where workspace_id = (:'f'::jsonb->>'ws')::uuid), 0, 'platform agent without grants reads no pages');
select is(public.get_page_bundle('page_A'), null, 'platform agent without grants gets no bundle');

-- prices for the hosted database
select tests.reset_role();
select is((select count(*)::int from public.model_prices where model in ('muse-spark-1.3', 'muse-spark-open-1026', 'meta-models/muse-spark-open-1026')), 3, 'model prices exist');

select * from finish();
rollback;
