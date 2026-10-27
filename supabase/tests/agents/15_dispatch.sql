begin;
select plan(7);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A3', 'page_A');

-- Dependencies live inside one context: two subtasks of the same parent.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A3', '{"objective":"Parent"}'::jsonb) ->> 'task_id' as parent \gset
select public.create_agent_task('page_A1', '{"objective":"Dispatch me"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as task \gset
select tests.reset_role();

-- Every event becomes one queue message.
insert into public.agent_events (workspace_id, task_id, agent_id, type, payload, seq)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, (:'f'::jsonb->>'agent')::uuid, 'task.continue', '{"text":"go"}', 1)
returning event_id as ev \gset
select ok(exists (select 1 from pgmq.q_agent_dispatch where message->>'event_id' = :'ev'), 'an event lands in the agent_dispatch queue');

-- Two feedback events within 30 s collapse into one pending event.
insert into public.agent_events (workspace_id, task_id, agent_id, type, payload, seq)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, (:'f'::jsonb->>'agent')::uuid, 'task.feedback', '{"text":"first"}', 2);
insert into public.agent_events (workspace_id, task_id, agent_id, type, payload, seq)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, (:'f'::jsonb->>'agent')::uuid, 'task.feedback', '{"text":"second"}', 3);
select is((select count(*)::int from public.agent_events where task_id = :'task'::uuid and type = 'task.feedback' and status = 'queued'), 1,
          'two feedback events within 30 s leave one pending event');
select is((select payload->>'text' from public.agent_events where task_id = :'task'::uuid and type = 'task.feedback'), E'first\n\nsecond',
          'the pending event carries both messages');

-- task.start waits for open dependencies.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A2', '{"objective":"After the first"}'::jsonb, null, :'parent'::uuid, '{}', array[:'task'::uuid]) ->> 'task_id' as t2 \gset
select tests.reset_role();
insert into public.agent_events (workspace_id, task_id, agent_id, type, payload, seq)
values ((:'f'::jsonb->>'ws')::uuid, :'t2'::uuid, (:'f'::jsonb->>'agent')::uuid, 'task.start', '{}', 1);
select is((select count(*)::int from public.agent_events where task_id = :'t2'::uuid), 0, 'task.start is not queued while a dependency is open');

-- Consumer side is service_role only.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of('select public.dispatch_dequeue()'), '42501', 'authenticated cannot dequeue');
select tests.reset_role();
select tests.set_service();
select (m->>'msg_id')::bigint as msg from jsonb_array_elements(public.dispatch_dequeue(20, 60)) m where m->'event'->>'event_id' = :'ev' \gset
select public.dispatch_ack(:'msg'::bigint, :'ev'::uuid, true);
select tests.reset_role();
select is((select status from public.agent_events where event_id = :'ev'::uuid), 'delivered', 'dispatch_ack(ok) marks the event delivered');
select ok(not exists (select 1 from pgmq.q_agent_dispatch where message->>'event_id' = :'ev'), 'the acknowledged message leaves the queue');

select * from finish();
rollback;
