begin;
select plan(67);
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
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40)), null, 'Merge?'))->>'status', 'pending', 'no review and no CI: a person decides');

-- 3. A review alone is not enough for a rule that also asks for CI.
select public.review_task(:'sub'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified","note":"reads right"}]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 2), null, 'Merge?'))->>'status', 'pending', 'review without CI: a person decides');
select tests.reset_role();

-- 4. A failed run: still a person.
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 1, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'failure',
  'html_url', 'https://github.com/acme/app/runs/1', 'head_branch', 'a/x', 'completed_at', now()));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 3), null, 'Merge?'))->>'status', 'pending', 'a red run: a person decides');
select tests.reset_role();

-- 5-7. Green and approved: granted, recorded as a condition.
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 2, 'name', 'check', 'head_sha', repeat('a', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/2', 'head_branch', 'a/x', 'completed_at', now() + interval '1 second'));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40)), null, 'Merge?') as res \gset
select is(:'res'::jsonb->>'status', 'approved', 'approved and green: granted');
select is(:'res'::jsonb->'auto_approved'->>'by', 'condition', 'recorded as a condition');
select ok(:'res'::jsonb ? 'receipt', 'with a receipt');


-- Historical authorship and human veto are facts of the delivered object, not the latest author label.
select tests.reset_role();
insert into public.agent_artifacts(workspace_id,task_id,run_id,kind,ref,title,version,satisfies,author_type,author_id,superseded_by)
select workspace_id,task_id,run_id,kind,ref,title,99,satisfies,'agent',(:'lead'::jsonb->>'agent')::uuid,id from public.agent_artifacts where id=:'art'::uuid returning id as authored_before \gset
select is(private.deterministic_checks_pass(:'sub'::uuid),false,'redeclaring a commit does not make its author independent for deterministic close');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid,%L,%L::jsonb,%L::jsonb,null,%L::uuid)',:'sub','approved','[{"criterion_id":"c1","status":"verified"}]','[]',:'lr')),'self_review','all versions of the ref retain authorship');
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','history'))->>'status','pending','a superseded authorship record denies conditional authority');
select tests.reset_role();
update public.agent_artifacts set ref='https://github.com/ACME/APP/commit/'||repeat('A',40) where id=:'authored_before'::uuid;
select is(private.deterministic_checks_pass(:'sub'::uuid),false,'a commit URL alias retains historical authorship for deterministic checks');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid,%L,%L::jsonb,%L::jsonb,null,%L::uuid)',:'sub','approved','[{"criterion_id":"c1","status":"verified"}]','[]',:'lr')),'self_review','canonical commit identity rejects review through a different spelling');
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','history-alias'))->>'status','pending','conditional proof cannot hide its author behind a commit alias');
select tests.reset_role();
update public.agent_artifacts set ref='acme/app@'||repeat('e',40) where id=:'authored_before'::uuid;
select is(private.deterministic_checks_pass(:'sub'::uuid),true,'an independent reviewer still satisfies deterministic close');
insert into public.agent_reviews(workspace_id,task_id,reviewer_type,reviewer_id,artifact_id,artifact_version,brief_version,verdict,findings,evidence,direct_session,created_at)
select workspace_id,task_id,'human',(:'f'::jsonb->>'owner')::uuid,artifact_id,artifact_version,brief_version,'changes_requested','[]','[]',true,now()-interval '1 minute'
from public.agent_reviews where task_id=:'sub'::uuid limit 1 returning id as veto \gset
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','human-veto'))->>'status','pending','a later Lead review cannot override human rejection of the same delivery');
select tests.reset_role();
update public.agent_reviews set verdict='approved' where id=:'veto'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','human-approval'))->>'status','approved','human approval does not veto an otherwise valid independent proof');

-- Authorization changes cannot be bypassed by an old receipt or a pending operation label.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'parent'::uuid,'{"policies":{"preapproved":["git.merge","send_email"]}}');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','old-receipt')) as old_receipt \gset
select public.begin_external_op(:'lr'::uuid,'smtp','send_email','{"to":"fixture@example.test"}') as brief_op \gset
select is(public.begin_external_op(:'lr'::uuid,'smtp','send_email','{"to":"fixture@example.test"}')->>'op_id',:'brief_op'::jsonb->>'op_id','current brief authorization resumes the same operation');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'parent'::uuid,'{"policies":{"preapproved":[]}}');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','old-receipt')) as current_receipt \gset
select is(:'current_receipt'::jsonb->'auto_approved'->>'by','condition','an automatic receipt is reused only under its current authorization');
select isnt(:'current_receipt'::jsonb->>'receipt',:'old_receipt'::jsonb->>'receipt','the stale brief receipt is not reused as a conditional receipt');
select public.begin_external_op(:'lr'::uuid,'smtp','send_email','{"to":"fixture@example.test"}') as revoked_op \gset
select is(:'revoked_op'::jsonb->>'status','approval_required','a pending brief-approved operation rechecks a withdrawn authorization');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval((:'revoked_op'::jsonb->>'approval_id')::uuid,'approve') as permit \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.begin_external_op(:'lr'::uuid,'smtp','send_email','{"to":"fixture@example.test"}',(:'permit'::jsonb->>'receipt')::uuid)->>'op_id',:'brief_op'::jsonb->>'op_id','human reauthorization preserves the provider idempotency key');
select is(public.begin_external_op(:'lr'::uuid,'smtp','send_email','{"to":"fixture@example.test"}')->>'op_id',:'brief_op'::jsonb->>'op_id','the live consumed human receipt still authorizes retry');
select tests.reset_role();
update public.agent_approvals set receipt_expires_at=now()-interval '1 second' where receipt=(:'permit'::jsonb->>'receipt')::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.begin_external_op(:'lr'::uuid,'smtp','send_email','{"to":"fixture@example.test"}')->>'status','approval_required','an expired human receipt does not authorize retry');

-- Review binding regressions: each mutation breaks one fact of the same proof.
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub'), null, 'Merge?'))->>'status', 'pending', 'the action must name its commit');
select is((public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo','acme/other','head_sha',repeat('f',40))))->>'status', 'approval_required', 'a different repository and commit ask a person');
select tests.reset_role();
update public.agent_reviews set findings='[]' where task_id=:'sub'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','no-findings')))->>'status','pending','approved without a verified CI finding proves nothing');
select tests.reset_role();
update public.agent_reviews set findings='[{"criterion_id":"c1","status":"verified","note":"checked"}]' where task_id=:'sub'::uuid;
update public.agent_tasks set state='done',acceptance='rejected' where id=:'sub'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','rejected')))->>'status','pending','human rejection overrides approved evidence');
select tests.reset_role();
update public.agent_tasks set state='cancelled' where id=:'sub'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','cancelled')))->>'status','pending','cancellation overrides approved evidence');
select tests.reset_role();
update public.agent_tasks set state='ready_for_review',acceptance='pending' where id=:'sub'::uuid;
update public.task_briefs set policies=policies || '{"require_approval":["git.merge"]}' where task_id=:'sub'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','required')))->>'status','pending','subject require_approval overrides the parent rule');
select tests.reset_role();
update public.task_briefs set policies=policies-'require_approval' where task_id=:'sub'::uuid;
update public.agent_artifacts set author_id=(:'lead'::jsonb->>'agent')::uuid where id=:'art'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid,%L,%L::jsonb,%L::jsonb,null,%L::uuid)',:'sub','approved','[{"criterion_id":"c1","status":"verified"}]','[]',:'lr')),'self_review','the author cannot review their own artifact');
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','self')))->>'status','pending','legacy self approval also proves nothing');
select tests.reset_role();
update public.agent_artifacts set author_id=(:'f'::jsonb->>'agent')::uuid where id=:'art'::uuid;
update public.agent_reviews set created_at=now()-interval '1 minute' where task_id=:'sub'::uuid;
insert into public.agent_oauth_links(user_id,client_id,as_human) values ((:'f'::jsonb->>'owner')::uuid,'g2-chat',true);
select tests.set_human((:'f'::jsonb->>'owner')::uuid,'g2-chat');
select public.review_task(:'sub'::uuid,'approved','[{"criterion_id":"c1","status":"verified"}]');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40),'case','chat')))->>'status','pending','a chat review cannot authorize an outside action');
select tests.reset_role();
-- Restore the independent review as latest without deleting the chat review.
update public.agent_reviews set created_at=now()+interval '1 second' where task_id=:'sub'::uuid and reviewer_type='agent';
update public.agent_runs set stop_requested_at=now() where id=:'lr'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.request_approval(%L::uuid,%L,%L::jsonb)',:'lr','git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40)))),'run_not_active','stop fences approval requests');
select is(tests.error_of(format('select public.begin_external_op(%L::uuid,%L,%L,%L::jsonb)',:'lr','github','git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40)))),'run_not_active','stop fences external operations');
select tests.reset_role();
update public.agent_runs set stop_requested_at=null where id=:'lr'::uuid;
-- A newer delivery without satisfies cannot borrow CI from an older commit.
insert into public.agent_artifacts(workspace_id,task_id,run_id,kind,ref,title,version,satisfies,author_type,author_id,created_at)
select workspace_id,task_id,run_id,kind,'acme/app@'||repeat('d',40),title,1,'{}',author_type,author_id,now()+interval '3 seconds'
from public.agent_artifacts where id=:'art'::uuid returning id as unmatched_art \gset
update public.agent_reviews set artifact_id=:'unmatched_art'::uuid where task_id=:'sub'::uuid and reviewer_type='agent';
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('d',40),'case','unmatched')))->>'status','pending','review and green CI must prove the same newest commit');
select tests.reset_role();
update public.agent_artifacts set superseded_by=:'art'::uuid where id=:'unmatched_art'::uuid;
update public.agent_reviews set artifact_id=:'art'::uuid,outdated_by=null,outdated_at=null where task_id=:'sub'::uuid and reviewer_type='agent';
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);

-- 8. The act goes through with its receipt.
select public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40)), (:'res'::jsonb->>'receipt')::uuid) as original_op \gset
select isnt(:'original_op'::jsonb->>'status','approval_required','the receipt opens the operation');

-- 9. require_approval wins over a condition.
select is((public.request_approval(:'lr'::uuid, 'deploy', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40)), null, 'Deploy?'))->>'status', 'pending', 'require_approval still asks');

-- 10. The subject must be a subtask of this task.
select is((public.request_approval(:'or_run'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40)), null, 'Merge?'))->>'status', 'pending', 'a subtask of another parent proves nothing');

-- 11. No ci criterion means ci_green is not proved.
select public.review_task(:'noci'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified","note":"fine"}]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'noci'), null, 'Merge?'))->>'status', 'pending', 'no ci criterion: ci_green is not proved');

-- 12. A commit delivered after the approval: the check at the moment of acting sends it to a person.
-- A different commit ref leaves the old artifact unsuperseded, as add_artifact does.
select public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 'freshness'), null, 'Merge?') as fresh_receipt \gset
select tests.reset_role();
insert into public.agent_artifacts (workspace_id, task_id, run_id, kind, ref, title, version, satisfies, author_type, author_id, created_at)
select workspace_id, task_id, run_id, kind, 'acme/app@' || repeat('c', 40), title, 1, satisfies, author_type, author_id, now() + interval '2 seconds'
 from public.agent_artifacts where id = :'art'::uuid returning id as fresh_art \gset
select tests.set_service();
select public.record_ci_check(:'conn'::uuid, 'acme/app', jsonb_build_object('id', 3, 'name', 'check', 'head_sha', repeat('c', 40), 'conclusion', 'success',
  'html_url', 'https://github.com/acme/app/runs/3', 'head_branch', 'a/x', 'completed_at', now() + interval '2 seconds'));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 'unreviewed'), null, 'Merge?'))->>'status', 'pending', 'green CI on a new unsuperseded commit still needs a current review');
select is((public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 'freshness'), (:'fresh_receipt'::jsonb->>'receipt')::uuid))->>'status', 'approval_required', 'a conditional receipt cannot authorize a newer unreviewed commit');
select public.begin_external_op(:'lr'::uuid,'github','git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40))) as stale_op \gset
select is(:'stale_op'::jsonb->>'status','approval_required','retrying a pending conditional operation rechecks the latest proof');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval((:'stale_op'::jsonb->>'approval_id')::uuid,'approve') as human_override \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.begin_external_op(:'lr'::uuid,'github','git.merge',jsonb_build_object('subtask_id',:'sub','repo','acme/app','head_sha',repeat('a',40)),(:'human_override'::jsonb->>'receipt')::uuid) as resumed_op \gset
select is(:'resumed_op'::jsonb->>'op_id',:'original_op'::jsonb->>'op_id','a valid direct-human override resumes the same idempotent operation');
select is(:'resumed_op'::jsonb->>'status','pending','the explicit approval is not trapped behind the stale condition');
select tests.reset_role();
update public.agent_artifacts set superseded_by = :'art'::uuid where id = :'fresh_art'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'sub'::uuid, '{"objective":"Changed acceptance context"}'::jsonb);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 'stale-brief'), null, 'Merge?'))->>'status', 'pending', 'a review of an older brief cannot approve a merge');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select tests.reset_role();
insert into public.agent_artifacts (workspace_id, task_id, run_id, kind, ref, title, version, satisfies, author_type, author_id)
select workspace_id, task_id, run_id, kind, 'acme/app@' || repeat('b', 40), title, version + 1, satisfies, author_type, author_id from public.agent_artifacts where id = :'art'::uuid
returning id as art2 \gset
update public.agent_artifacts set superseded_by = :'art2'::uuid where id = :'art'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.begin_external_op(:'lr'::uuid, 'github', 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 'after')))->>'status', 'approval_required', 'a newer commit sends it to a person');
select tests.reset_role();

-- Page proofs and ancestor bounds fail closed as well.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.update_brief(:'parent'::uuid, '{"policies":{"preapproved_if":{"publish_page":["review_approved"]}}}');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'publish_page',jsonb_build_object('subtask_id',:'noci','page_id','page_O')))->>'status','approved','the current reviewed page is authorized');
select tests.reset_role();

select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'publish_page',jsonb_build_object('subtask_id',:'noci','page_id','page_X'))->>'status','pending','a reviewed page does not authorize a different page');
select is(public.request_approval(:'lr'::uuid,'publish_page',jsonb_build_object('subtask_id',:'noci','ref','page_O'))->>'status','pending','page_id is mandatory; aliases cannot name the proof');
select is(public.begin_external_op(:'lr'::uuid,'workspace','publish_page',jsonb_build_object('subtask_id',:'noci'))->>'status','approval_required','the act cannot omit page_id');

select tests.reset_role();
-- A cyclic legacy ancestor chain also exceeds the bounded traversal, even with no veto in the first ten hops.
update public.agent_tasks set parent_task_id=:'other'::uuid where id=:'parent'::uuid;
update public.agent_tasks set parent_task_id=:'parent'::uuid where id=:'other'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid,'publish_page',jsonb_build_object('subtask_id',:'noci','page_id','page_O','case','depth')))->>'status','pending','an unbounded ancestor chain never authorizes an effect');
select tests.reset_role();
update public.agent_tasks set parent_task_id=null where id in (:'parent'::uuid,:'other'::uuid);
select set_config('app.ops_write','1',true);
update public.pages set data=jsonb_set(data,'{title}','"Changed since review"') where id='page_O';
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is((public.begin_external_op(:'lr'::uuid,'workspace','publish_page',jsonb_build_object('subtask_id',:'noci','page_id','page_O','case','edited')))->>'status','approval_required','a page edited after its review asks a person');
select tests.reset_role();

-- 13-15. Trust: only a person writing from the app.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid, %L::jsonb)', :'sub', '{"policies":{"preapproved_if":{"git.merge":["review_approved"]}}}')), 'owner_required', 'a Lead cannot write a conditional rule');
select is((public.request_approval(:'lr'::uuid, 'git.merge', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40), 'try', 'lead'), null, 'Merge?'))->>'status', 'pending', 'and that rule grants nothing');
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
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'parent','{"policies":{"preapproved_if":{"payment":["review_approved"]}}}')),'invalid_input','payment conditions are rejected on brief update');
select tests.reset_role();
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'page_payment','page_A');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.create_agent_task(%L,%L::jsonb,%L::uuid)','page_payment','{"objective":"Pay","policies":{"preapproved_if":{"payment":["ci_green"]}}}',:'lead'::jsonb->>'agent')),'invalid_input','payment conditions are rejected on task creation');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is((public.request_approval(:'lr'::uuid, 'payment', jsonb_build_object('subtask_id', :'sub', 'repo', 'acme/app', 'head_sha', repeat('a',40)), null, 'Pay?'))->>'status', 'pending', 'a payment always waits for a person');
select tests.reset_role();

-- A human approval is scoped to its task, even when another task has identical action parameters.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.request_approval(:'lr'::uuid,'http_request','{"url":"https://scope.test"}') as scoped_request \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval((:'scoped_request'::jsonb->>'approval_id')::uuid,'approve') as scoped_receipt \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.begin_external_op(%L::uuid,%L,%L,%L::jsonb,%L::uuid)',:'or_run','scope','http_request','{"url":"https://scope.test"}',:'scoped_receipt'::jsonb->>'receipt')),'approval_mismatch','another task cannot consume the human receipt');
select is(tests.error_of(format('select public.begin_external_op(%L::uuid,%L,%L,%L::jsonb,%L::uuid)',:'lr','scope','http_request','{"url":"https://scope.test"}',:'scoped_receipt'::jsonb->>'receipt')),'','the authorized task can still consume that receipt');
select tests.reset_role();
-- Model an operation opened by the old cross-task path, without performing any external effect.
update public.external_ops set task_id=:'other'::uuid,run_id=:'or_run'::uuid where task_id=:'parent'::uuid and provider='scope';
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.begin_external_op(:'or_run'::uuid,'scope','http_request','{"url":"https://scope.test"}')->>'status','approval_required','a legacy pending operation cannot borrow another task human approval');
select tests.reset_role();

-- Public-RPC lifecycle: changing the artifact row is not changing the rejected commit.
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'veto_subject','page_A');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.create_subtask(:'parent'::uuid,'veto_subject','{"objective":"Veto history","done_when":[{"id":"c","text":"Deliver","check":"lead"}]}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as veto_sub \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'veto_sub'::uuid,'codex')->>'run_id' as vr1 \gset
select public.add_artifact(:'vr1'::uuid,'diff','acme/app@'||repeat('a',40),'Rejected commit',array['c'])->>'artifact_id' as va1 \gset
select public.submit_for_review(:'vr1'::uuid,'Ready',array[:'va1'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'veto_sub'::uuid,'changes_requested','[{"criterion_id":"c","status":"contradicted","note":"Fix this commit"}]');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'veto_sub'::uuid,'codex')->>'run_id' as vr2 \gset
select public.add_artifact(:'vr2'::uuid,'diff','https://github.com/ACME/APP/commit/'||repeat('A',40),'Same commit',array['c'])->>'artifact_id' as va2 \gset
select public.submit_for_review(:'vr2'::uuid,'Unchanged commit',array[:'va2'::uuid]);
select tests.reset_role();
update public.agent_artifacts set created_at=now()+interval '1 second' where id=:'va2'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'veto_sub'::uuid,'approved','[{"criterion_id":"c","status":"verified"}]','[]',:'va2'::uuid,:'lr'::uuid)->>'review_id' as latest_veto_review \gset
select tests.reset_role();
update public.agent_reviews set created_at=now()+interval '1 second' where id=:'latest_veto_review'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'veto_sub','repo','acme/app','head_sha',repeat('a',40)))->>'status','pending','redeclaring a rejected commit cannot erase the human veto');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid,'g2-chat');
select public.review_task(:'veto_sub'::uuid,'approved','[{"criterion_id":"c","status":"verified"}]','[]',:'va2'::uuid)->>'review_id' as chat_lift \gset
select tests.reset_role();
update public.agent_reviews set created_at=now()+interval '1.5 seconds' where id=:'chat_lift'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'veto_sub'::uuid,'approved','[{"criterion_id":"c","status":"verified"}]','[]',:'va2'::uuid,:'lr'::uuid)->>'review_id' as after_chat_review \gset
select tests.reset_role();
update public.agent_reviews set created_at=now()+interval '1.75 seconds' where id=:'after_chat_review'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'veto_sub','repo','acme/app','head_sha',repeat('a',40)))->>'status','pending','a chat approval cannot lift a direct human veto for an automatic effect');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'veto_sub'::uuid,'approved','[{"criterion_id":"c","status":"verified"}]','[]',:'va2'::uuid)->>'review_id' as human_lift \gset
select tests.reset_role();
update public.agent_reviews set created_at=now()+interval '2 seconds' where id=:'human_lift'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'veto_sub','repo','acme/app','head_sha',repeat('a',40)))->>'status','approved','a later real human approval lifts the veto without rewriting history');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'veto_sub'::uuid,'changes_requested','[{"criterion_id":"c","status":"contradicted","note":"New concern"}]','[]',:'va2'::uuid)->>'review_id' as second_veto \gset
select tests.reset_role();
update public.agent_reviews set created_at=now()+interval '3 seconds' where id=:'second_veto'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'veto_sub'::uuid,'codex')->>'run_id' as vr3 \gset
select public.add_artifact(:'vr3'::uuid,'diff','acme/app@'||repeat('b',40),'New commit',array['c'])->>'artifact_id' as va3 \gset
select public.submit_for_review(:'vr3'::uuid,'Changed commit',array[:'va3'::uuid]);
select tests.reset_role();
update public.agent_artifacts set created_at=now()+interval '4 seconds' where id=:'va3'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'veto_sub'::uuid,'approved','[{"criterion_id":"c","status":"verified"}]','[]',:'va3'::uuid,:'lr'::uuid)->>'review_id' as new_commit_review \gset
select tests.reset_role();
update public.agent_reviews set created_at=now()+interval '4 seconds' where id=:'new_commit_review'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'lr'::uuid,'git.merge',jsonb_build_object('subtask_id',:'veto_sub','repo','acme/app','head_sha',repeat('b',40)))->>'status','approved','a genuinely new independently reviewed commit is not vetoed by older content');
select tests.reset_role();

select * from finish();
rollback;

