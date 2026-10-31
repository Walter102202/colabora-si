begin;
select plan(10);

select tests.fixture() as f \gset
-- Match the explicit As-you consent link required by the HTTP session hook.
insert into public.agent_oauth_links (user_id, client_id, as_human)
values ((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1', true);
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Parent work"}'::jsonb) ->> 'task_id' as parent \gset
select public.create_agent_task('page_A2', '{"objective":"Subtask work"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as sub \gset

select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_task(%L::uuid, %L)', :'sub', 'accepted')), 'humans_only', 'an agent cannot close a task');

-- The worker delivers, then the review escalates to a person after the allowed rounds.
select public.claim_task(:'sub'::uuid, 'custom') ->> 'run_id' as run \gset
select public.add_artifact(:'run'::uuid, 'page', 'page_A2', 'Result', '{}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'run'::uuid, 'Done', array[:'art'::uuid]);
select tests.reset_role();
update public.agent_tasks set state = 'input_required', waiting_on = 'human', review_rounds = 3 where id = :'sub'::uuid;
-- A question still open on the task when the person closes it.
insert into public.agent_approvals (workspace_id, task_id, run_id, kind, question, options, requested_by_type, requested_by_id)
values ((:'f'::jsonb->>'ws')::uuid, :'sub'::uuid, :'run'::uuid, 'elicitation', 'Which tone?', array['respond','ignore'], 'agent', (:'f'::jsonb->>'agent')::uuid)
returning id as q \gset

-- Closing executes nothing irreversible (Reopen exists), so a chat session may do it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1');
select is(tests.error_of(format('select public.close_task(%L::uuid, %L, %L)', :'sub', 'accepted', 'Good enough')), '', 'an OAuth session may close a task that is ready for a person');
select is((select status from public.agent_approvals where id = :'q'::uuid), 'cancelled', 'closing cancels the open question');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'done', 'a person closes the escalated subtask');
select is((select acceptance from public.agent_tasks where id = :'sub'::uuid), 'accepted', 'the subtask is accepted');
select is((select count(*)::int from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated'), 0,
          'no task.updated when the parent has no delegate');

-- close_subtask: only the Lead of the parent, and only by brief policy or a verified deterministic check.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A3','page_A4','page_A5','page_A6','page_A7']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A3', '{"objective":"Lead parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as p1 \gset
select public.create_agent_task('page_A4', '{"objective":"Policy parent","policies":{"subtask_close":"lead"}}'::jsonb,
                                (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as p2 \gset
select public.create_agent_task('page_A5', '{"objective":"No rule"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'p1'::uuid) ->> 'task_id' as s1 \gset
select public.create_agent_task('page_A6', '{"objective":"Checked","done_when":[{"id":"d1","text":"Tests pass","check":"deterministic","command":"npm test"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'p1'::uuid) ->> 'task_id' as s2 \gset
select public.create_agent_task('page_A7', '{"objective":"By policy"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'p2'::uuid) ->> 'task_id' as s3 \gset

-- The worker delivers the three subtasks.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.submit_for_review(x.run, 'Done', array[(public.add_artifact(x.run, 'page', x.page, 'Out', x.sat) ->> 'artifact_id')::uuid])
  from (select (public.claim_task(t, 'custom') ->> 'run_id')::uuid as run, page, sat
          from (values (:'s1'::uuid, 'page_A5', '{}'::text[]), (:'s2'::uuid, 'page_A6', array['d1']), (:'s3'::uuid, 'page_A7', '{}'::text[])) v(t, page, sat)) x;

select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'s3')), 'lead_only', 'a worker cannot close a subtask');

select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'p1'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.claim_task(:'p2'::uuid, 'claude_code');
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'s1')), 'policy_denied', 'without policy or checks the Lead cannot close');
select public.close_subtask(:'s3'::uuid);
select public.review_task(:'s2'::uuid, 'approved', '[{"criterion_id":"d1","status":"verified","note":"green"}]'::jsonb,
                          '[{"kind":"capture","ref":"npm test"}]'::jsonb, null, :'lr'::uuid);
select public.close_subtask(:'s2'::uuid, 'accepted', '[{"kind":"capture","ref":"npm test"}]'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'s3'::uuid), 'done', 'the Lead closes by brief policy');
select is((select state from public.agent_tasks where id = :'s2'::uuid), 'done', 'the Lead closes after a verified deterministic check');

select * from finish();
rollback;
