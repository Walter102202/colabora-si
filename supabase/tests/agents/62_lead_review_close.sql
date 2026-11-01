begin;
select plan(5);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_L1','page_L2','page_L3']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+oauthlead@agents.invalid', 'lead', 'page_A') as lead \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_L1', '{"objective":"Lead parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.create_agent_task('page_L2', '{"objective":"Lead checks","done_when":[{"id":"d1","text":"Tests pass","check":"deterministic","command":"npm test"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as sub \gset
select public.create_agent_task('page_L3', '{"objective":"Person checks","done_when":[{"id":"d1","text":"Tests pass","check":"deterministic","command":"npm test"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as chat_sub \gset

select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.submit_for_review(x.run, 'Done', array[(public.add_artifact(x.run, 'page', x.page, 'Out', array['d1']) ->> 'artifact_id')::uuid])
  from (select (public.claim_task(t, 'custom') ->> 'run_id')::uuid as run, page
          from (values (:'sub'::uuid, 'page_L2'), (:'chat_sub'::uuid, 'page_L3')) v(t, page)) x;

-- The Lead reviews one delivery. Over OAuth this row is stored with direct_session false.
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.review_task(:'sub'::uuid, 'approved', '[{"criterion_id":"d1","status":"verified","note":"green"}]'::jsonb,
                          '[{"kind":"capture","ref":"npm test"}]'::jsonb, null, :'lr'::uuid);
select tests.reset_role();
update public.agent_reviews set direct_session = false where task_id = :'sub'::uuid;

-- A person's review from a chat stays out, even with the same findings.
insert into public.agent_reviews (workspace_id, task_id, reviewer_type, reviewer_id, artifact_id, artifact_version, brief_version, verdict, findings, evidence, direct_session)
select t.workspace_id, t.id, 'human', (:'f'::jsonb->>'owner')::uuid, a.id, a.version, t.brief_version, 'approved',
       '[{"criterion_id":"d1","status":"verified"}]'::jsonb, '[{"kind":"capture","ref":"npm test"}]'::jsonb, false
  from public.agent_tasks t join public.agent_artifacts a on a.task_id = t.id where t.id = :'chat_sub'::uuid;

select is(private.deterministic_checks_pass(:'sub'::uuid), false, 'conditional effects still need a direct session');
select is(private.deterministic_checks_pass(:'sub'::uuid, true), true, 'an agent review counts for closing a subtask');

select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'chat_sub')), 'policy_denied', 'a chat review by a person does not close');
select is(tests.error_of(format('select public.close_subtask(%L::uuid, %L, %L::jsonb)', :'sub', 'accepted', '[{"kind":"capture","ref":"npm test"}]')), '', 'the Lead closes after its OAuth review');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'done', 'the subtask is done');

select * from finish();
rollback;
