begin;
select plan(17);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_L','page_W','page_S','page_K']) p;
update public.agents set capabilities = capabilities || '{"resume":true}'::jsonb where id = (:'f'::jsonb->>'agent')::uuid;
select tests.reset_role();

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_L', '{"objective":"Lease"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t \gset
select public.create_agent_task('page_W', '{"objective":"Waits on a person"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as w \gset
select public.create_agent_task('page_S', '{"objective":"Short lease","policies":{"lease_minutes":30}}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as s \gset
select public.create_agent_task('page_K', '{"objective":"Stop asked"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as k \gset
select tests.reset_role();

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t'::uuid, 'codex', 'session-1') ->> 'run_id' as r \gset
select public.claim_task(:'w'::uuid, 'codex') ->> 'run_id' as rw \gset
select public.request_approval(:'rw'::uuid, 'email.send', '{}'::jsonb, null, 'Send it?');
select public.claim_task(:'s'::uuid, 'codex') ->> 'run_id' as rs \gset
select public.claim_task(:'k'::uuid, 'codex') ->> 'run_id' as rk \gset
select tests.reset_role();

-- 1. A run that signals keeps its task.
select is((private.agent_housekeeping())->>'released', '0', 'a fresh run keeps its task');

-- 2-3. Silent past the stale mark but inside the lease: visible as stale, task untouched.
update public.agent_runs set last_signal_at = now() - interval '60 minutes' where id = :'r'::uuid;
select is((private.agent_housekeeping())->>'released', '0', 'stale inside the lease is not released');
select isnt((select stale_at from public.agent_runs where id = :'r'::uuid), null, 'but it is marked stale');

-- 4-8. Past the default lease the task goes back to the same delegate as a handover.
update public.agent_runs set last_signal_at = now() - interval '121 minutes' where id in (:'r'::uuid, :'rw'::uuid, :'rk'::uuid);
update public.agent_runs set stop_requested_at = now() where id = :'rk'::uuid;
update public.agent_runs set last_signal_at = now() - interval '31 minutes' where id = :'rs'::uuid;
select is((private.agent_housekeeping())->>'released', '2', 'the expired run and the short lease are released, nothing else');
select is((select state from public.agent_tasks where id = :'t'::uuid), 'queued', 'the task is queued again');
select is((select delegate_agent_id::text from public.agent_tasks where id = :'t'::uuid), :'f'::jsonb->>'agent', 'for the same delegate');
select is((select status || ':' || error_message from public.agent_runs where id = :'r'::uuid), 'cancelled:lease expired', 'the run is cancelled with its reason');
select is((select body->>'handover' from public.agent_activities where task_id = :'t'::uuid and type = 'prompt' order by seq desc limit 1), 'true', 'the agent sees a handover');

-- 9. policies.lease_minutes is honored: the 31 minute silence was enough here.
select is((select state from public.agent_tasks where id = :'s'::uuid), 'queued', 'a shorter lease in the brief is honored');

-- 10-11. A task waiting on a person, and a run a person asked to stop, are not this rule's to release.
select is((select state from public.agent_tasks where id = :'w'::uuid), 'input_required', 'a task waiting on a person keeps its run');
select is((select active_run_id::text from public.agent_tasks where id = :'k'::uuid), :'rk', 'a stop in progress is left to its own rule');

-- 12. The old session is fenced.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.submit_for_review(%L::uuid, %L, array[gen_random_uuid()])', :'r', 'late')), 'run_not_active', 'a late delivery from the old run is refused');

-- 13. The same agent picks it up with resume.
select ok((public.claim_task(:'t'::uuid, 'codex', 'session-2', null, true)) ? 'run_id', 'the agent resumes the task');
select ok(public.add_artifact((select active_run_id from public.agent_tasks where id = :'t'::uuid), 'page', 'page_L', 'Current artifact') ? 'artifact_id', 'the resumed active run can add an artifact');
select is(tests.error_of(format('select public.add_artifact(%L::uuid, %L, %L, %L)', :'r', 'page', 'page_L', 'Late artifact')), 'run_not_active', 'an expired run cannot supersede the resumed session artifact');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select ok(public.add_artifact(:'r'::uuid, 'page', 'page_L', 'Human correction') ? 'artifact_id', 'a direct human can still attach a correction to a finished run');
select tests.reset_role();

-- 14. A second pass finds nothing to do: the release is not repeated.
select is((private.agent_housekeeping())->>'released', '0', 'nothing is released twice');

select * from finish();
rollback;
