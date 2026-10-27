begin;
select plan(5);

select tests.fixture() as f \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Draft the plan","done_when":[{"id":"c1","text":"Plan drafted","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset
select public.add_artifact(:'run'::uuid, 'page', 'page_A1', 'Plan', array['c1']) ->> 'artifact_id' as art1 \gset

-- A reviewer asked for changes on version 1.
select tests.reset_role();
insert into public.agent_reviews (workspace_id, task_id, reviewer_type, reviewer_id, artifact_id, artifact_version, brief_version, verdict)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, 'human', (:'f'::jsonb->>'owner')::uuid, :'art1'::uuid, 1, 1, 'changes_requested');
update public.agent_tasks set review_state = 'changes_requested' where id = :'task'::uuid;

-- A new version of the same artifact outdates that review.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.add_artifact(:'run'::uuid, 'page', 'page_A1', 'Plan', array['c1']) ->> 'artifact_id' as art2 \gset
select tests.reset_role();
select is((select outdated_by from public.agent_reviews where artifact_id = :'art1'::uuid), 'artifact', 'a new artifact version outdates the review');
select is((select review_state from public.agent_tasks where id = :'task'::uuid), 'outdated', 'the task review state is outdated');

-- A review of version 2, then a brief update outdates it too.
insert into public.agent_reviews (workspace_id, task_id, reviewer_type, reviewer_id, artifact_id, artifact_version, brief_version, verdict)
values ((:'f'::jsonb->>'ws')::uuid, :'task'::uuid, 'human', (:'f'::jsonb->>'owner')::uuid, :'art2'::uuid, 2, 1, 'approved');
update public.agent_tasks set review_state = 'approved' where id = :'task'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'task'::uuid, '{"constraints":"Keep it under one page"}'::jsonb);
select tests.reset_role();
select is((select outdated_by from public.agent_reviews where artifact_id = :'art2'::uuid), 'brief', 'a brief update outdates the review');
select is((select review_state from public.agent_tasks where id = :'task'::uuid), 'outdated', 'the task review state is outdated again');
select is((select count(*)::int from public.agent_reviews where task_id = :'task'::uuid), 2, 'outdated reviews are kept');

select * from finish();
rollback;
