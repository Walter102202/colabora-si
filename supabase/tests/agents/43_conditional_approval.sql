begin;
select plan(21);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_P','page_S','page_O','page_X']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+condlead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.reset_role();

-- 1. An unknown condition is refused when the brief is written.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.create_agent_task(%L, %L::jsonb, %L::uuid)', 'page_P',
  '{"objective":"x","policies":{"preapproved_if":{"git.merge":["moon_is_full"]}}}', :'lead'::jsonb->>'agent')), 'invalid_input', 'an unknown condition is refused');

select public.create_ci_connection((:'f'::jsonb->>'ws')::uuid, 'acme/app') ->> 'id' as conn \gset
select public.create_agent_task('page_P', '{"objective":"Parent","policies":{"subtask_close":"lead","preapproved_if":{"git.merge":["review_approved","ci_green"],"deploy":["review_approved"]},"require_approval":["deploy"]}}'::jsonb,
                                (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.create_agent_task('page_S', '{"objective":"Sub","done_when":[{"id":"c1","text":"CI is green","check":"ci","command":"check"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as sub \gset
select public.create_agent_task('page_O', '{"objective":"No CI","done_when":[{"id":"c1","text":"Works","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid, :'parent'::uuid) ->> 'task_id' as noci \gset
select public.create_agent_task('page_X', '{"objective":"Other parent"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as other \gset
select tests.reset_role();

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as run \gset
select public.add_artifact(:'run'::uuid, 'diff', 'acme/app@' || repeat('a', 40), 'Commit', array['c1']) ->> 'artifact_id' as art \gset
select public.submit_for_review(:'run'::uuid, 'done', array[:'art'::uuid]);
select public.claim_task(:'noci'::uuid, 'codex') ->> 'run_id' as run3 \gset
select public.add_artifact(:'run3'::uuid, 'page', 'page_O', 'Notes', array['c1']) ->> 'artifact_id' as art3 \gset
select public.submit_for_review(:'run3'::uuid, 'done', array[:'art3'::uuid]);
select tests.reset_role();

select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.claim_task(:'other'::uuid, 'claude_code') ->> 'run_id' as or_run \gset
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', repeat('-', 36)), null, 'Merge?'))->>'status', 'pending', 'a malformed subject cannot satisfy a conditional approval');

-- 2. Nothing proved yet: a person decides.
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub'), null, 'Merge?'))->>'status', 'pending', 'no review and no CI: a person decides');

-- 3. A review alone is not enough for a rule that also asks for CI.
select public.review_task(:'sub'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified","note":"reads right"}]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 2), null, 'Merge?'))->>'status', 'pending', 'review without CI: a person decides');
select tests.reset_role();

-- 4. A failed run: still a person.
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 1, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'failure',
  'html_url', 'https://github.com/acme/app/runs/1', 'head_branch', 'a/x', 'completed_at', now()));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 3), null, 'Merge?'))->>'status', 'pending', 'a red run: a person decides');
select tests.reset_role();

-- 5-7. Green and approved: granted, recorded as a condition.
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 2, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/2', 'head_branch', 'a/x', 'completed_at', now() + interval '1 second'));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub'), null, 'Merge?') as res \gset
select is(:'res'::jsonb->>'status', 'approved', 'approved and green: granted');
select is(:'res'::jsonb->'auto_approved'->>'by', 'condition', 'recorded as a condition');
select ok(:'res'::jsonb ? 'receipt', 'with a receipt');

-- 8. The act goes through with its receipt.
select isnt((public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub'), (:'res'::jsonb->>'receipt')::uuid))->>'status', 'approval_required', 'the receipt opens the operation');

-- 9. require_approval wins over a condition.
select is((public.request_approval(:'lr'::uuid, 'deploy', jsonb_build_object('subtask_id', :'sub'), null, 'Deploy?'))->>'status', 'pending', 'require_approval still asks');

-- 10. The subject must be a subtask of this task.
select is((public.request_approval(:'or_run'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub'), null, 'Merge?'))->>'status', 'pending', 'a subtask of another parent proves nothing');

-- 11. No ci criterion means ci_green is not proved.
select public.review_task(:'noci'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified","note":"fine"}]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'noci'), null, 'Merge?'))->>'status', 'pending', 'no ci criterion: ci_green is not proved');

-- 12. A commit delivered after the approval: the check at the moment of acting sends it to a person.
-- A different commit ref leaves the old artifact unsuperseded, as add_artifact does.
select public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 'freshness'), null, 'Merge?') as fresh_receipt \gset
select tests.reset_role();
insert into public.agent_artifacts (workspace_id, task_id, run_id, kind, ref, title, version, satisfies, author_type, author_id, created_at)
select workspace_id, task_id, run_id, kind, 'acme/app@' || repeat('c', 40), title, 1, satisfies, author_type, author_id, now() + interval '2 seconds'
 from public.agent_artifacts where id = :'art'::uuid returning id as fresh_art \gset
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 3, 'name', 'check', 'head_sha', repeat('c', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/3', 'head_branch', 'a/x', 'completed_at', now() + interval '2 seconds'));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 'unreviewed'), null, 'Merge?'))->>'status', 'pending', 'green CI on a new unsuperseded commit still needs a current review');
select is((public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 'freshness'), (:'fresh_receipt'::jsonb->>'receipt')::uuid))->>'status', 'approval_required', 'a conditional receipt cannot authorize a newer unreviewed commit');
select tests.reset_role();
update public.agent_artifacts set superseded_by = :'art'::uuid where id = :'fresh_art'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'sub'::uuid, '{"objective":"Changed acceptance context"}'::jsonb);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 'stale-brief'), null, 'Merge?'))->>'status', 'pending', 'a review of an older brief cannot approve a merge');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select tests.reset_role();
insert into public.agent_artifacts (workspace_id, task_id, run_id, kind, ref, title, version, satisfies, author_type, author_id)
select workspace_id, task_id, run_id, kind, 'acme/app@' || repeat('b', 40), title, version + 1, satisfies, author_type, author_id from public.agent_artifacts where id = :'art'::uuid
returning id as art2 \gset
update public.agent_artifacts set superseded_by = :'art2'::uuid where id = :'art'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 'after')))->>'status', 'approval_required', 'a newer commit sends it to a person');
select tests.reset_role();

-- 13-15. Trust: only a person writing from the app.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid, %L::jsonb)', :'sub', '{"policies":{"preapproved_if":{"git.merge":["review_approved"]}}}')), 'owner_required', 'a Lead cannot write a conditional rule');
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'try', 'lead'), null, 'Merge?'))->>'status', 'pending', 'and that rule grants nothing');
select tests.reset_role();
-- Match the explicit As-you consent link required by the HTTP session hook.
insert into public.agent_oauth_links (user_id, client_id, as_human)
values ((:'f'::jsonb->>'owner')::uuid, 'chat-client', true);
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'chat-client');
select is(tests.error_of(format('select public.update_brief(%L::uuid, %L::jsonb)', :'parent', '{"policies":{"preapproved_if":{"git.merge":["review_approved"]}}}')), 'direct_session_required', 'a chat cannot change the rule');
select tests.reset_role();

-- 16. Changing the rule keeps trust only when it comes from the app.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'parent'::uuid, '{"policies":{"subtask_close":"lead","preapproved_if":{"git.merge":["review_approved"]}}}'::jsonb);
select is((select preapproved_trusted from public.task_briefs where task_id = :'parent'::uuid order by version desc limit 1), true, 'a person in the app keeps it trusted');
select tests.reset_role();

-- 17. A payment never runs on a condition.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'parent'::uuid, '{"policies":{"subtask_close":"lead","preapproved_if":{"payment":["review_approved"]}}}'::jsonb);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'payment', jsonb_build_object('subtask_id', :'sub'), null, 'Pay?'))->>'status', 'pending', 'a payment always waits for a person');
select tests.reset_role();

select * from finish();
rollback;
