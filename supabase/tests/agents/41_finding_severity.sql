begin;
select plan(14);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_P','page_S','page_R']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+sevlead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+sevrev@agents.invalid', 'worker', 'page_A') as rev \gset
select tests.reset_role();

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_P', '{"objective":"Parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.create_agent_task('page_S', '{"objective":"Sub","done_when":[{"id":"c1","text":"Works","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as sub \gset
select tests.reset_role();

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as run \gset
select public.add_artifact(:'run'::uuid, 'page', 'page_S', 'Notes', array['c1']) ->> 'artifact_id' as art \gset
select public.submit_for_review(:'run'::uuid, 'done', array[:'art'::uuid]);
select tests.reset_role();

select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset

-- 1-5. What the rule refuses.
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'approved',
  '[{"criterion_id":"c1","status":"verified","severity":"nit"}]', '[]', :'lr')), 'invalid_input', 'an unknown severity is refused');
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'approved',
  '[{"status":"unverified","severity":"minor"}]', '[]', :'lr')), 'invalid_input', 'a minor finding says what it is');
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'approved',
  '[{"criterion_id":"nope","status":"verified"}]', '[]', :'lr')), 'unknown_criterion', 'a blocking finding still names a criterion of the brief');
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'changes_requested',
  '[{"status":"unverified","severity":"minor","note":"typo in a log"}]', '[]', :'lr')), 'no_blocking_findings', 'minors alone never send work back');
select is(tests.error_of(format('select public.review_task(%L::uuid, %L, %L::jsonb, %L::jsonb, null, %L::uuid)', :'sub', 'approved',
  '[{"criterion_id":"c1","status":"contradicted","note":"it fails"}]', '[]', :'lr')), 'blocking_findings_open', 'an approval cannot carry an open blocking finding');

-- 6-9. Changes requested with a minor alongside: one round, and the worker gets only what blocks.
select is((public.review_task(:'sub'::uuid, 'changes_requested',
  '[{"criterion_id":"c1","status":"contradicted","note":"npm test fails"},{"status":"unverified","severity":"minor","note":"rename this helper"}]'::jsonb,
  '[]'::jsonb, null, :'lr'::uuid))->>'rounds', '1', 'the round counts the blocking finding');
select ok((select body->>'text' from public.agent_activities where task_id = :'sub'::uuid and type = 'prompt' order by seq desc limit 1) like '%npm test fails%', 'the worker gets what blocks');
select ok((select body->>'text' from public.agent_activities where task_id = :'sub'::uuid and type = 'prompt' order by seq desc limit 1) not like '%rename this helper%', 'and not the minor');
select is((select jsonb_array_length(findings) from public.agent_reviews where task_id = :'sub'::uuid order by created_at desc limit 1), 2, 'the review keeps both');
select tests.reset_role();

-- 10-12. Round two through a reviewer agent: approved with a minor, the round stays, the Lead hears about it.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as run2 \gset
select public.submit_for_review(:'run2'::uuid, 'fixed', array[:'art'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select tests.make_review_task('page_R', format('{"objective":"Review","policies":{"review_of":"%s"}}', :'sub')::jsonb, (:'rev'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as rt \gset
select tests.reset_role();
select tests.set_agent((:'rev'::jsonb->>'user')::uuid, (:'rev'::jsonb->>'agent')::uuid);
select public.claim_task(:'rt'::uuid, 'claude_code') ->> 'run_id' as rr \gset
select is((public.review_task(:'sub'::uuid, 'approved',
  '[{"criterion_id":"c1","status":"verified","note":"passes"},{"status":"unverified","severity":"minor","note":"docs could say more"}]'::jsonb,
  '[]'::jsonb, null, :'rr'::uuid))->>'rounds', '1', 'a minor does not count a round');
select tests.reset_role();
select is((select review_state from public.agent_tasks where id = :'sub'::uuid), 'approved', 'a minor does not stop the approval');
select is((select payload->'minor_findings'->0->>'note' from public.agent_events
            where task_id = :'parent'::uuid and type = 'task.updated' and payload ? 'verdict' order by created_at desc limit 1),
          'docs could say more', 'the Lead hears about the minor');

-- Minor notes cannot substitute for acceptance evidence, even when they name a criterion.
update public.task_briefs set done_when = '[{"id":"c1","text":"Works","check":"deterministic","command":"npm test"}]'::jsonb
 where task_id = :'sub'::uuid;
update public.agent_reviews set findings = '[{"criterion_id":"c1","status":"verified","severity":"minor","note":"Optional polish"}]'::jsonb,
 evidence = '[{"kind":"test","ref":"npm test"}]'::jsonb where task_id = :'sub'::uuid;
select is(private.deterministic_checks_pass(:'sub'::uuid), false, 'a verified minor finding does not prove an acceptance criterion');
update public.agent_reviews set findings = '[{"criterion_id":"c1","status":"verified","severity":"blocking","note":"Test passed"}]'::jsonb
 where task_id = :'sub'::uuid;
select is(private.deterministic_checks_pass(:'sub'::uuid), true, 'verified blocking evidence still proves the criterion');

select * from finish();
rollback;
