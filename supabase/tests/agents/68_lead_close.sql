begin;
select plan(13);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A')
  from unnest(array['page_J1','page_C1','page_C2','page_C3','page_C4','page_C5','page_J2','page_C6','page_C7']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+closelead@agents.invalid', 'lead', 'page_A') as lead \gset
insert into public.agent_workspace_policies (workspace_id, autonomy)
values ((:'f'::jsonb->>'ws')::uuid, 'autonomous')
on conflict (workspace_id) do update set autonomy = 'autonomous';

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid, 'autonomous');
select public.create_agent_task('page_J1', '{"objective":"A job from the template button"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as job \gset
select public.create_agent_task('page_C1', '{"objective":"Lead checks","done_when":[{"id":"c1","text":"Good","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'job'::uuid) ->> 'task_id' as closes \gset
select public.create_agent_task('page_C2', '{"objective":"Person checks","done_when":[{"id":"c1","text":"Good","check":"human"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'job'::uuid) ->> 'task_id' as needs_person \gset
select public.create_agent_task('page_C3', '{"objective":"Not reviewed","done_when":[{"id":"c1","text":"Good","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'job'::uuid) ->> 'task_id' as unreviewed \gset
select public.create_agent_task('page_C4', '{"objective":"Own work","done_when":[{"id":"c1","text":"Good","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'job'::uuid) ->> 'task_id' as own_work \gset
select public.create_agent_task('page_C5', '{"objective":"Lower autonomy","done_when":[{"id":"c1","text":"Good","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'job'::uuid) ->> 'task_id' as lower_level \gset

select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.submit_for_review(x.run, 'Done', array[(public.add_artifact(x.run, 'page', x.page, 'Out', array['c1']) ->> 'artifact_id')::uuid])
  from (select (public.claim_task(t, 'custom') ->> 'run_id')::uuid as run, page
          from (values (:'closes'::uuid, 'page_C1'), (:'needs_person'::uuid, 'page_C2'), (:'unreviewed'::uuid, 'page_C3'),
                       (:'own_work'::uuid, 'page_C4'), (:'lower_level'::uuid, 'page_C5')) v(t, page)) x;

select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.review_task(t, 'approved', '[{"criterion_id":"c1","status":"verified"}]'::jsonb, '[]'::jsonb, null, :'lr'::uuid)
  from unnest(array[:'closes'::uuid, :'needs_person'::uuid, :'own_work'::uuid, :'lower_level'::uuid]) t;

select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'closes')), '', 'the Lead closes an approved subtask of a job without a closure policy');
-- Probe deferral without consuming the delivery used by the rejection regression below.
select is(tests.error_of(format('do $b$ declare r jsonb; begin r:=public.close_subtask(%L::uuid); raise exception using message=r->>''human''; end $b$',:'needs_person')),
          'deferred_to_job','a human criterion waits for the job Accept after independent review');
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'unreviewed')), 'policy_denied', 'a delivery nobody approved stays open');

-- Whoever authored the delivery cannot be the one whose approval closes it.
select tests.reset_role();
update public.agent_artifacts set author_id = (:'lead'::jsonb->>'agent')::uuid where task_id = :'own_work'::uuid;
select is(private.lead_may_close(:'own_work'::uuid, :'job'::uuid), false, 'an author approving its own delivery does not close it');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid, 'balanced');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'lower_level')), 'policy_denied', 'Balanced leaves the close to a person');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid, 'autonomous');
select tests.reset_role();
insert into public.agent_workspace_policies (workspace_id, autonomy)
values ((:'f'::jsonb->>'ws')::uuid, 'ask')
on conflict (workspace_id) do update set autonomy = 'ask';
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'lower_level')), 'policy_denied', 'Ask first stops the Lead too');
select tests.reset_role();
update public.agent_workspace_policies set autonomy = 'autonomous' where workspace_id = (:'f'::jsonb->>'ws')::uuid;

-- A person's Accept on a job settles what was delivered under it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_J2', '{"objective":"A second job"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as job2 \gset
select public.create_agent_task('page_C6', '{"objective":"Delivered"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'job2'::uuid) ->> 'task_id' as delivered \gset
select public.create_agent_task('page_C7', '{"objective":"Still queued"}'::jsonb, (:'f'::jsonb->>'agent')::uuid, :'job2'::uuid) ->> 'task_id' as queued \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'delivered'::uuid, 'custom') ->> 'run_id' as dr \gset
select public.add_artifact(:'dr'::uuid, 'page', 'page_C6', 'Out', array[]::text[]) ->> 'artifact_id' as da \gset
select public.submit_for_review(:'dr'::uuid, 'Done', array[:'da'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job2'::uuid, 'claude_code') ->> 'run_id' as jr \gset
select public.add_artifact(:'jr'::uuid, 'page', 'page_J2', 'Out', array[]::text[]) ->> 'artifact_id' as ja \gset
select public.submit_for_review(:'jr'::uuid, 'Done', array[:'ja'::uuid]);
select is(tests.error_of(format('select public.close_task(%L::uuid, %L)', :'job2', 'accepted')), 'humans_only', 'the job itself is closed by a person');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'job2'::uuid, 'accepted');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'job2'::uuid), 'done', 'Accept closes the job');
select is((select state from public.agent_tasks where id = :'delivered'::uuid), 'done', 'Accept closes its delivered subtask');
select is((select acceptance from public.agent_tasks where id = :'delivered'::uuid), 'accepted', 'the subtask is accepted with it');
select is((select closed_by from public.agent_tasks where id = :'delivered'::uuid), (:'f'::jsonb->>'owner')::uuid, 'the person closed it');
select is((select state from public.agent_tasks where id = :'queued'::uuid), 'queued', 'work that was not delivered stays open');

-- Rejecting a job says nothing about what was delivered under it.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.add_artifact(:'lr'::uuid, 'page', 'page_J1', 'Out', array[]::text[]) ->> 'artifact_id' as first_job_artifact \gset
select public.submit_for_review(:'lr'::uuid, 'Done', array[:'first_job_artifact'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.close_task(:'job'::uuid, 'rejected');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'needs_person'::uuid), 'ready_for_review', 'a rejected job leaves its deliveries for the person');

select * from finish();
rollback;
