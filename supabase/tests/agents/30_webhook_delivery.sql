begin;
select plan(9);
select tests.fixture() as f \gset
select tests.make_user('agent+hook@agents.invalid') as uh \gset
select tests.make_user('agent+ref@agents.invalid') as ur \gset

-- 1-2. Delivery follows the connection when the agent is created (agent-admin calls create_agent as service_role).
select tests.set_service();
select public.create_agent((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, :'uh'::uuid, 'Hook', 'webhook', 'worker', null, '{}'::jsonb,
                           '{"webhook_url":"https://hook.example/agent"}'::jsonb) ->> 'agent_id' as hook \gset
-- Settings creates the reference agent (it pulls with wait_for_my_tasks) with kind webhook and no webhook_url.
select public.create_agent((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, :'ur'::uuid, 'Reference', 'webhook', 'worker', null, '{}'::jsonb,
                           '{"harness":"agent"}'::jsonb) ->> 'agent_id' as ref \gset
select tests.reset_role();
select is((select delivery from public.agents where id = :'hook'::uuid), 'push', 'an agent created with a webhook_url is pushed to');
select is((select delivery from public.agents where id = :'ref'::uuid), 'pull', 'an agent created without a webhook_url pulls, whatever its kind');

-- 3-5. update_agent replaces the connection: delivery follows it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_agent(:'ref'::uuid, '{"connection":{"harness":"custom","webhook_url":"https://hook.example/ref"}}'::jsonb);
select tests.reset_role();
select is((select delivery from public.agents where id = :'ref'::uuid), 'push', 'adding a webhook_url turns delivery to push');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_agent(:'ref'::uuid, '{"connection":{"harness":"custom","webhook_url":""}}'::jsonb);
select tests.reset_role();
select is((select delivery from public.agents where id = :'ref'::uuid), 'pull', 'an empty webhook_url is no webhook');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_agent(:'hook'::uuid, '{"name":"Hook renamed"}'::jsonb);
select tests.reset_role();
select is((select delivery from public.agents where id = :'hook'::uuid), 'push', 'a patch that keeps the connection keeps push');

-- 6-7. delivery cannot disagree with the connection, which is also how the migration fixed older rows.
update public.agents set delivery = 'push' where id = (:'f'::jsonb->>'agent')::uuid;
select is((select delivery from public.agents where id = (:'f'::jsonb->>'agent')::uuid), 'pull', 'push without a webhook_url is not kept');
update public.agents set delivery = 'pull' where id = :'hook'::uuid;
select is((select delivery from public.agents where id = :'hook'::uuid), 'push', 'pull with a webhook_url is not kept');

-- 8-9. agent-dispatch reads delivery from dispatch_dequeue: the webhook agent's event comes out as push, the others as pull.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Hooked"}'::jsonb) ->> 'task_id' as task \gset
select tests.reset_role();
delete from pgmq.q_agent_dispatch;
insert into public.agent_events (workspace_id, task_id, agent_id, type, payload, seq)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, :'hook'::uuid, 'task.continue', '{"text":"go"}', 1),
       ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, (:'f'::jsonb->>'agent')::uuid, 'task.continue', '{"text":"go"}', 2);
select tests.set_service();
select public.dispatch_dequeue(10, 60) as batch \gset
select tests.reset_role();
select is((select m->'agent'->>'delivery' from jsonb_array_elements(:'batch'::jsonb) m where m->'agent'->>'id' = :'hook'), 'push',
          'the webhook agent is dequeued as push');
select is((select m->'agent'->>'delivery' from jsonb_array_elements(:'batch'::jsonb) m where m->'agent'->>'id' = :'f'::jsonb->>'agent'), 'pull',
          'an agent without a webhook_url is dequeued as pull');

select * from finish();
rollback;
