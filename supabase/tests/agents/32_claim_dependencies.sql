begin;
select plan(9);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['dep_a','dep_b','dep_c','dep_d']) p;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A', '{"objective":"Deliver both steps"}', (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.create_agent_task('dep_a', '{"objective":"First step"}', (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as a \gset
select public.create_agent_task('dep_b', '{"objective":"Second step"}', (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid,
  p_depends_on_task_ids => array[:'a'::uuid]) ->> 'task_id' as b \gset
select public.create_agent_task('dep_c', '{"objective":"Cancelled step"}', (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as c \gset
select public.create_agent_task('dep_d', '{"objective":"Wait for cancelled step"}', (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid,
  p_depends_on_task_ids => array[:'c'::uuid]) ->> 'task_id' as d \gset
select tests.reset_role();
-- now() is transaction-stable; make the saved cursor older and put B before A in claim order.
update public.agent_tasks set created_at = now() - interval '1 minute', updated_at = now() - interval '1 minute' where id = :'b'::uuid;
update public.agent_tasks set state = 'cancelled' where id = :'c'::uuid;
select updated_at as b_before from public.agent_tasks where id = :'b'::uuid \gset
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'custom');
select is(public.claim_task(null, 'custom') ->> 'task_id', :'a', 'claim without an id takes A, never the blocked B');
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'b', 'custom')), 'dependency_open', 'claiming B by id is refused while A is open');
select ok(tests.detail_of(format('select public.claim_task(%L::uuid, %L)', :'b', 'custom'))::jsonb -> 'open' ? :'a', 'the refusal names the open dependency');
select active_run_id as run_a from public.agent_tasks where id = :'a'::uuid \gset
select public.add_artifact(:'run_a'::uuid, 'page', 'dep_a', 'First step', '{}') ->> 'artifact_id' as artifact \gset
select public.submit_for_review(:'run_a'::uuid, 'First step complete', array[:'artifact'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'a'::uuid, 'accepted');
select tests.reset_role();
select ok((select updated_at from public.agent_tasks where id = :'b'::uuid) > :'b_before'::timestamptz, 'releasing B touches its row so cursor waits see it');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'b'::uuid, 'custom') as claimed_b \gset
select is(:'claimed_b'::jsonb ->> 'task_id', :'b', 'B is claimable once A is done');
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'d', 'custom')), 'dependency_open', 'a cancelled dependency keeps it blocked');
select lives_ok(format('select public.heartbeat(%L::uuid)', :'claimed_b'::jsonb ->> 'run_id'), 'a working task with deps keeps running');
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'b', 'custom')), 'task_unavailable', 'a working task remains unavailable to a second claim');
select tests.reset_role();
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+outsider@agents.invalid', 'worker', 'page_B') as other \gset
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'d', 'custom')), 'task_unavailable', 'another agent cannot discover the open dependencies of a task it cannot claim');
select tests.reset_role();
select * from finish();
rollback;
