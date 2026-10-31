begin;
select plan(50);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_P','page_S','page_F','page_O']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+cilead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_user('ci-stranger@test.local') as stranger \gset
select tests.reset_role();

-- 1-5. Connecting a repository is the owner's, from a direct session.
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.create_ci_connection(%L::uuid, %L)', :'f'::jsonb->>'ws', 'acme/app')), 'forbidden', 'a stranger cannot connect a repository');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'chat-client');
select is(tests.error_of(format('select public.create_ci_connection(%L::uuid, %L)', :'f'::jsonb->>'ws', 'acme/app')), 'direct_session_required', 'a chat cannot connect a repository');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.create_ci_connection(%L::uuid, %L)', :'f'::jsonb->>'ws', 'acme/app')), 'humans_only', 'an agent cannot connect a repository');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.create_ci_connection(%L::uuid, %L)', :'f'::jsonb->>'ws', 'not a repo')), 'invalid_input', 'the name must be owner/name');
select public.create_ci_connection((:'f'::jsonb->>'ws')::uuid, 'Acme/App') ->> 'id' as conn \gset
select is((public.create_ci_connection((:'f'::jsonb->>'ws')::uuid, 'acme/app'))->>'id', :'conn', 'connecting twice returns the live connection');
select public.create_ci_connection((:'f'::jsonb->>'ws')::uuid, 'acme/other') ->> 'id' as conn2 \gset

-- A Lead's parent with three subtasks: one passes, one fails, one has the wrong commit.
select public.create_agent_task('page_P', '{"objective":"Parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset

-- 6-7. A ci criterion names its check.
select is(tests.error_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid, %L::uuid)', 'page_S',
  '{"objective":"No command","done_when":[{"id":"c1","text":"CI","check":"ci"}]}', :'f'::jsonb->>'agent', :'parent')), 'invalid_input', 'a ci criterion without a check name is refused');
select is(tests.detail_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid, %L::uuid)', 'page_S',
  '{"objective":"No command","done_when":[{"id":"c1","text":"CI","check":"ci"}]}', :'f'::jsonb->>'agent', :'parent')), 'a ci criterion names its GitHub check in command', 'and the refusal says why');
select public.create_agent_task('page_S', '{"objective":"Ships","done_when":[{"id":"c1","text":"CI is green","check":"ci","command":"check"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as sub \gset
select public.create_agent_task('page_F', '{"objective":"Fails","done_when":[{"id":"c1","text":"CI is green","check":"ci","command":"check"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as bad \gset
select tests.reset_role();

-- 8-10. The commit: nothing delivered, then a page artifact is refused at submit, then a commit is accepted.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as run \gset
select is((public.task_ci_status(:'sub'::uuid))->0->>'state', 'no_commit', 'before a delivery there is no commit');
select public.add_artifact(:'run'::uuid, 'page', 'page_S', 'Notes', array['c1']) ->> 'artifact_id' as page_art \gset
select is(tests.error_of(format('select public.submit_for_review(%L::uuid, %L, array[%L::uuid])', :'run', 'done', :'page_art')), 'ci_commit_required', 'a ci criterion needs a commit');
select public.add_artifact(:'run'::uuid, 'diff', 'Acme/App@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Commit', array['c1']) ->> 'artifact_id' as art \gset
select is((public.submit_for_review(:'run'::uuid, 'done', array[:'art'::uuid]))->>'task_state', 'ready_for_review', 'a commit satisfies the delivery');
select is((public.task_ci_status(:'sub'::uuid))->0->>'state', 'pending', 'connected and delivered, waiting for GitHub');
-- 12. An agent cannot write the evidence.
select is(tests.sqlstate_of(format('select public.record_ci_check(%L::uuid, %L, %L::jsonb)', :'conn', 'acme/app', '{}')), '42501', 'an agent cannot call record_ci_check');
select public.claim_task(:'bad'::uuid, 'codex') ->> 'run_id' as run2 \gset
select public.add_artifact(:'run2'::uuid, 'diff', 'https://github.com/acme/app/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Commit', array['c1']) ->> 'artifact_id' as art2 \gset
select public.submit_for_review(:'run2'::uuid, 'done', array[:'art2'::uuid]);
select tests.reset_role();

-- 13. A person cannot either.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format('select public.record_ci_check(%L::uuid, %L, %L::jsonb)', :'conn', 'acme/app', '{}')), '42501', 'a person cannot call record_ci_check');
select tests.reset_role();

-- 14-16. Only the connected repository, and a run from before the task proves nothing.
select tests.set_service();
select is(tests.error_of(format('select public.record_ci_check(%L::uuid, %L, %L::jsonb)', :'conn', 'evil/app', '{}')), 'repo_mismatch', 'a delivery for another repository is refused');
select is((public.record_ci_check(:'conn'::uuid, 'acme/app', null))->>'recorded', 'false', 'a ping records nothing');
select is((public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 1, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/1', 'head_branch', 'a/x', 'completed_at', now() - interval '1 day')))->>'recorded', 'true', 'an old run is stored');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.task_ci_status(:'sub'::uuid))->0->>'state', 'pending', 'but it does not prove a newer task');
select tests.reset_role();

-- 17. The Lead reviews before CI ends: review alone does not close.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.review_task(:'sub'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified","note":"looks right"}]'::jsonb,
                          '[]'::jsonb, null, :'lr'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'sub')), 'policy_denied', 'a verified finding without a passing run does not close');
select tests.reset_role();
update public.task_briefs set policies = '{"subtask_close":"lead"}' where task_id = :'parent'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('do $b$ begin perform public.close_subtask(%L::uuid); raise exception ''unexpected_success''; end $b$', :'sub')),
          'policy_denied', 'lead policy cannot bypass a missing CI pass');
select tests.reset_role();
update public.task_briefs set policies = '{}' where task_id = :'parent'::uuid;

-- 18-22. GitHub says it passed: the history shows it and the Lead hears.
select tests.set_service();
select is((public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 2, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/2', 'head_branch', 'a/x', 'app_slug', 'github-actions', 'started_at', now(), 'completed_at', now())))->>'tasks', '1', 'the run reaches the task delivering that commit');
select is((public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 2, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/2', 'completed_at', now())))->>'recorded', 'false', 'a repeated delivery changes nothing');
select tests.reset_role();
select is((select count(*)::int from public.agent_activities where task_id = :'sub'::uuid and body ? 'ci'), 1, 'one line in the history, and none for the old run');
select is((select count(*)::int from public.agent_events where task_id = :'parent'::uuid and type = 'task.updated' and payload ? 'ci'), 1, 'the Lead is told once');
select is((select count(*)::int from public.agent_events where task_id = :'sub'::uuid and type = 'task.updated' and payload ? 'ci'), 0, 'a pass does not wake the worker');
-- A different commit is a new artifact, not a new version of the same ref. Its review must be its own.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, :'art'::uuid, :'lr'::uuid);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as updated_run \gset
select public.add_artifact(:'updated_run'::uuid, 'diff', 'acme/app@cccccccccccccccccccccccccccccccccccccccc', 'New commit', array['c1']) ->> 'artifact_id' as newer_art \gset
select public.submit_for_review(:'updated_run'::uuid, 'updated', array[:'newer_art'::uuid]);
select tests.reset_role();
update public.agent_artifacts set created_at = now() + interval '1 second' where id = :'newer_art'::uuid;
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 6, 'name', 'check', 'head_sha', repeat('c', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/6', 'completed_at', now() + interval '2 seconds'));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(public.task_ci_status(:'sub'::uuid)->0->>'sha', repeat('c', 40), 'CI evaluates the newest delivered commit');
select is(tests.error_of(format('do $b$ begin perform public.close_subtask(%L::uuid); raise exception ''unexpected_success''; end $b$', :'sub')),
          'policy_denied', 'a verified review of the old commit cannot close a newer passing commit');
select public.review_task(:'sub'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified"}]'::jsonb, '[]'::jsonb, :'newer_art'::uuid, :'lr'::uuid);
select is((public.close_subtask(:'sub'::uuid))->>'task_state', 'done', 'the reviewer''s finding plus the passing run close it');
select tests.reset_role();

-- 24-28. A failure: the worker hears, a rerun that passes decides, a neutral conclusion is not a pass.
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 3, 'name', 'check', 'head_sha', repeat('b', 40), 'conclusion', 'failure',
  'html_url', 'https://github.com/acme/app/runs/3', 'completed_at', now() + interval '1 second'));
select tests.reset_role();
select is((select count(*)::int from public.agent_events where task_id = :'bad'::uuid and type = 'task.updated' and payload ? 'ci'), 1, 'a failure wakes the worker');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.task_ci_status(:'bad'::uuid))->0->>'state', 'failed', 'a failed run shows as failed');
select is((public.task_ci_status(:'bad'::uuid))->0->>'url', 'https://github.com/acme/app/runs/3', 'with its link');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 4, 'name', 'check', 'head_sha', repeat('b', 40), 'conclusion', 'neutral',
  'html_url', 'https://github.com/acme/app/runs/4', 'completed_at', now() + interval '2 seconds'));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.task_ci_status(:'bad'::uuid))->0->>'state', 'failed', 'a neutral conclusion is not a pass');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 5, 'name', 'check', 'head_sha', repeat('b', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/5', 'completed_at', now() + interval '3 seconds'));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.task_ci_status(:'bad'::uuid))->0->>'state', 'passed', 'the newest run on the commit decides');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)', :'bad')), 'policy_denied', 'passing CI without a verified review does not close');
select tests.reset_role();
update public.task_briefs set policies = '{"subtask_close":"lead"}' where task_id = :'parent'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('do $b$ begin perform public.close_subtask(%L::uuid); raise exception ''unexpected_success''; end $b$', :'bad')),
          'policy_denied', 'lead policy cannot bypass a missing verified CI review');
select tests.reset_role();
update public.task_briefs set policies = '{}' where task_id = :'parent'::uuid;
-- 29. Evidence stays in its workspace.
select tests.reset_role();
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.task_ci_status(%L::uuid)', :'bad')), 'not_found', 'a stranger cannot read the status');
select is((select count(*)::int from public.ci_check_runs), 0, 'nor the runs');
select tests.reset_role();

-- 31-34. A revoked connection stops the proof and the deliveries; bad input does not reach the table.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revoke_ci_connection(:'conn'::uuid);
select is((public.task_ci_status(:'bad'::uuid))->0->>'state', 'not_connected', 'a revoked repository proves nothing');
select public.create_ci_connection((:'f'::jsonb->>'ws')::uuid, 'acme/app');
select is((public.task_ci_status(:'bad'::uuid))->0->>'state', 'pending', 'reconnecting cannot reuse evidence from the revoked connection');
select tests.reset_role();
select tests.set_service();
select is(tests.error_of(format('select public.record_ci_check(%L::uuid, %L, %L::jsonb)', :'conn', 'acme/app', '{}')), 'connection_revoked', 'a revoked connection refuses deliveries');
select is(tests.error_of(format('select public.record_ci_check(%L::uuid, %L, %L::jsonb)', :'conn2', 'acme/other',
  '{"id":9,"name":"check","head_sha":"short","conclusion":"success","html_url":"https://github.com/x","completed_at":"2026-10-30T00:00:00Z"}')), 'invalid_input', 'a malformed sha is refused');
select is(tests.error_of(format('select public.record_ci_check(%L::uuid, %L, %L::jsonb)', :'conn2', 'acme/other',
  '{"id":9,"name":"check","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conclusion":"success","html_url":"javascript:alert(1)","completed_at":"2026-10-30T00:00:00Z"}')), 'invalid_input', 'a link outside GitHub is refused');
select tests.reset_role();

-- A Lead cannot supply both the artifact and its CI review, even through a delegated review task.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_ci_self','page_ci_worker','page_ci_self_review']) p;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.create_subtask(:'parent'::uuid, 'page_ci_self',
  '{"objective":"Self-authored CI","done_when":[{"id":"c1","text":"CI","check":"ci","command":"check"}]}'::jsonb,
  (:'lead'::jsonb->>'agent')::uuid)->>'task_id' as self_task \gset
select public.claim_task(:'self_task'::uuid, 'lead')->>'run_id' as self_run \gset
select public.add_artifact(:'self_run'::uuid, 'diff', 'acme/other@dddddddddddddddddddddddddddddddddddddddd', 'Self commit', array['c1'])->>'artifact_id' as self_art \gset
select public.submit_for_review(:'self_run'::uuid, 'done', array[:'self_art'::uuid]);
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn2'::uuid, 'acme/other', jsonb_build_object('id', 10, 'name', 'check', 'head_sha', repeat('d', 40),
  'conclusion', 'success', 'html_url', 'https://github.com/acme/other/runs/10', 'completed_at', now()));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'self_task'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified"}]'::jsonb, '[]'::jsonb, :'self_art'::uuid, :'lr'::uuid);
select is(tests.error_of(format('do $b$ begin perform public.close_subtask(%L::uuid); raise exception ''unexpected_success''; end $b$', :'self_task')),
          'policy_denied', 'the artifact author cannot supply the CI review key as Lead');
select public.create_subtask(:'parent'::uuid, 'page_ci_worker',
  '{"objective":"Worker-authored CI","done_when":[{"id":"c1","text":"CI","check":"ci","command":"check"}]}'::jsonb,
  (:'f'::jsonb->>'agent')::uuid)->>'task_id' as worker_self_task \gset
select public.create_subtask(:'parent'::uuid, 'page_ci_self_review',
  jsonb_build_object('objective', 'Review own commit', 'policies', jsonb_build_object('review_of', :'worker_self_task')),
  (:'f'::jsonb->>'agent')::uuid)->>'task_id' as self_review_task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'worker_self_task'::uuid, 'worker')->>'run_id' as worker_self_run \gset
select public.add_artifact(:'worker_self_run'::uuid, 'diff', 'acme/other@dddddddddddddddddddddddddddddddddddddddd', 'Worker commit', array['c1'])->>'artifact_id' as worker_self_art \gset
select public.submit_for_review(:'worker_self_run'::uuid, 'done', array[:'worker_self_art'::uuid]);
select public.claim_task(:'self_review_task'::uuid, 'reviewer')->>'run_id' as self_review_run \gset
select public.review_task(:'worker_self_task'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified"}]'::jsonb, '[]'::jsonb, :'worker_self_art'::uuid, :'self_review_run'::uuid);
select is(tests.error_of(format('do $b$ begin perform public.close_subtask(%L::uuid); raise exception ''unexpected_success''; end $b$', :'worker_self_task')),
          'policy_denied', 'a review task cannot let the artifact author supply the CI review key');
select tests.reset_role();

-- An agent cannot downgrade a failing CI criterion, including under a Lead closure policy.
select tests.set_service();
select public.record_ci_check(:'conn2'::uuid, 'acme/other', jsonb_build_object('id', 11, 'name', 'check', 'head_sha', repeat('d', 40),
  'conclusion', 'failure', 'html_url', 'https://github.com/acme/other/runs/11', 'completed_at', now() + interval '5 seconds'));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'parent'::uuid, '{"policies":{"subtask_close":"lead"}}');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('do $b$ begin perform public.update_brief(%L::uuid, %L::jsonb); raise exception ''unexpected_success''; end $b$', :'self_task', patch)),
          'ci_criteria_locked', label)
from (values
  ('{"done_when":[{"id":"c1","text":"CI","check":"deterministic","command":"check"}]}', 'the Lead cannot replace CI with deterministic evidence'),
  ('{"done_when":[{"id":"renamed","text":"CI","check":"ci","command":"check"}]}', 'the Lead cannot rename a CI criterion'),
  ('{"done_when":[{"id":"c1","text":"CI","check":"ci","command":"other"}]}', 'the Lead cannot change the required GitHub check'),
  ('{"done_when":[]}', 'the Lead cannot clear CI criteria under subtask_close lead')
) v(patch, label);
select ok(public.update_brief(:'self_task'::uuid, '{"done_when":[{"id":"c1","text":"Updated description","check":"ci","command":"check"}]}') > 1,
          'the Lead can update descriptive text while retaining the CI contract');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select ok(public.update_brief(:'self_task'::uuid, '{"done_when":[{"id":"human-choice","text":"CI","check":"ci","command":"other"}]}') > 1,
          'a person can change the CI contract');
select ok(public.update_brief(:'self_task'::uuid, '{"done_when":[]}') > 1, 'a person can remove a CI criterion');
select tests.reset_role();

select * from finish();
rollback;
