begin;
select plan(3);

select tests.fixture() as f \gset
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

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'sub'::uuid, 'accepted', 'Good enough');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'done', 'a person closes the escalated subtask');
select is((select acceptance from public.agent_tasks where id = :'sub'::uuid), 'accepted', 'the subtask is accepted');

select * from finish();
rollback;
