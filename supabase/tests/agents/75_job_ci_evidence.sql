begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_J','page_S1','page_S2','page_X']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+jobci@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_user('jobci-stranger@test.local') as stranger \gset
insert into public.agent_workspace_policies (workspace_id, autonomy) values ((:'f'::jsonb->>'ws')::uuid, 'autonomous') on conflict (workspace_id) do update set autonomy = 'autonomous';
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid, 'autonomous');
select public.create_ci_connection((:'f'::jsonb->>'ws')::uuid, 'acme/app')->>'id' as conn \gset
select public.create_agent_task('page_J', '{"objective":"Job"}', (:'lead'::jsonb->>'agent')::uuid)->>'task_id' as job \gset
select public.create_agent_task('page_S1', '{"objective":"Test","done_when":[{"id":"c1","text":"Tests pass","check":"ci","command":"test"}]}', (:'f'::jsonb->>'agent')::uuid, :'job'::uuid)->>'task_id' as s1 \gset
select public.create_agent_task('page_S2', '{"objective":"Build","done_when":[{"id":"c1","text":"Build passes","check":"ci","command":"build"}]}', (:'f'::jsonb->>'agent')::uuid, :'job'::uuid)->>'task_id' as s2 \gset
select is(public.job_ci_status(:'job'::uuid)->>'state', 'no_commit', 'inherited CI requires a final commit');
select is(public.job_ci_status(:'job'::uuid)->'checks', jsonb_build_array(jsonb_build_object('check','build','sources',jsonb_build_array(:'s2'),'state','no_commit'),jsonb_build_object('check','test','sources',jsonb_build_array(:'s1'),'state','no_commit')), 'distinct sorted checks retain their sources');
select is(public.job_ci_status(:'s1'::uuid)->>'state', 'none', 'subtasks have no job CI');
select tests.reset_role();
update public.agent_tasks set state='cancelled' where id=:'s2'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(jsonb_array_length(public.job_ci_status(:'job'::uuid)->'checks'),1,'cancelled subtasks do not contribute');
select tests.reset_role();
update public.agent_tasks set state='queued' where id=:'s2'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job'::uuid, 'custom')->>'run_id' as lr \gset
select public.add_artifact(:'lr'::uuid,'diff','acme/app@ffffffffffffffffffffffffffffffffffffffff','Final',array[]::text[])->>'artifact_id' as final \gset
select is(public.job_ci_status(:'job'::uuid)->>'state','pending','final commit waits for both checks');
select tests.reset_role();
update public.ci_connections set revoked_at=now() where id=:'conn'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.job_ci_status(:'job'::uuid)->>'state','not_connected','revoked connection cannot prove CI');
select tests.reset_role();
update public.ci_connections set revoked_at=null where id=:'conn'::uuid;
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.job_ci_status(%L::uuid)',:'job')),'not_found','inaccessible job is hidden');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.job_ci_status(%L::uuid)',:'job')),'42501','anonymous cannot call status');
select tests.reset_role();

-- Step 2: current independent review is the first key; only unknown CI is deferred.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'s1'::uuid,'custom')->>'run_id' as sr \gset
select public.add_artifact(:'sr'::uuid,'diff','acme/app@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Subtask',array['c1'])->>'artifact_id' as sa \gset
select public.submit_for_review(:'sr'::uuid,'Done',array[:'sa'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'s1')),'policy_denied','deferred CI still needs review');
select public.review_task(:'s1'::uuid,'approved','[{"criterion_id":"c1","status":"verified","evidence_ref":"https://github.com/acme/app/runs/1"}]','[]',null,:'lr'::uuid);
select tests.reset_role();
update public.ci_connections set revoked_at=now() where id=:'conn'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.close_subtask(:'s1'::uuid) as closed \gset
select is(:'closed'::jsonb->>'task_state','done','unconnected CI does not strand reviewed work');
select ok(not (:'closed'::jsonb ? 'ci'),'Autonomous closure does not defer CI');
select is(:'closed'::jsonb,'{"task_state":"done"}'::jsonb,'closed result needs no connection');
select tests.reset_role();
select ok(exists(select 1 from public.agent_activities where task_id=:'s1'::uuid and body->>'rule'='lead_review'),'history records deferral');
select ok(exists(select 1 from public.agent_events where task_id=:'job'::uuid and payload->>'subtask_state'='done'),'Lead event records deferral');
update public.agent_tasks set state='ready_for_review',acceptance='pending' where id=:'s1'::uuid;
update public.ci_connections set revoked_at=null where id=:'conn'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'balanced');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'s1')),'policy_denied','Balanced cannot defer without another policy');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'autonomous');
select tests.reset_role();
update public.agent_reviews set reviewer_id=(:'f'::jsonb->>'agent')::uuid where task_id=:'s1'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'s1')),'policy_denied','author cannot approve its own deferred delivery');
select tests.reset_role();
update public.agent_reviews set reviewer_id=(:'lead'::jsonb->>'agent')::uuid where task_id=:'s1'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(public.close_subtask(:'s1'::uuid)->>'task_state','done','pending CI allows evidenced Autonomous subtask close');
select tests.reset_role();
update public.agent_tasks set state='ready_for_review',acceptance='pending' where id=:'s1'::uuid;
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',101,'name','test','head_sha',repeat('a',40),'conclusion','failure','html_url','https://github.com/acme/app/runs/101','completed_at',now()));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'s1')),'policy_denied','known failure blocks deferral');
select is(tests.detail_of(format('select public.close_subtask(%L::uuid)',:'s1'))::jsonb->>'reason','ci_failed','failure explains its reason');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',102,'name','test','head_sha',repeat('a',40),'conclusion','success','html_url','https://github.com/acme/app/runs/102','completed_at',now()+interval '1 second'));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select tests.reset_role();
update public.agent_reviews set outdated_by='artifact' where task_id=:'s1'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'s1'::uuid,'approved','[{"criterion_id":"c1","status":"verified"}]','[]',null,:'lr'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'s1')),'policy_denied','passing CI still requires evidence_ref');
select public.review_task(:'s1'::uuid,'approved','[{"criterion_id":"c1","status":"verified","evidence_ref":"https://github.com/acme/app/runs/102"}]','[]',null,:'lr'::uuid);
select is(public.close_subtask(:'s1'::uuid),'{"task_state":"done"}'::jsonb,'passing CI follows the original close route');
select tests.reset_role();

-- A deterministic check remains independently proved while CI waits.
update public.task_briefs set done_when=done_when || '[{"id":"d1","text":"Local test","check":"deterministic","command":"npm test"}]' where task_id=:'s2'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'s2'::uuid,'custom')->>'run_id' as sr2 \gset
select public.add_artifact(:'sr2'::uuid,'diff','acme/app@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Mixed',array['c1','d1'])->>'artifact_id' as sa2 \gset
select public.submit_for_review(:'sr2'::uuid,'Done',array[:'sa2'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'balanced');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'s2'::uuid,'approved','[{"criterion_id":"c1","status":"unverified"},{"criterion_id":"d1","status":"verified"}]','[{"kind":"command","ref":"npm test"}]',null,:'lr'::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'s2','{"done_when":[{"id":"d1","text":"Local test","check":"deterministic","command":"npm test"}]}')),'ci_criteria_locked','Lead still cannot remove inherited CI requirements');
select is(public.close_subtask(:'s2'::uuid)->>'ci','deferred_to_job','verified deterministic evidence permits deferral at Balanced');
select tests.reset_role();

-- Step 3: one final delivery proves the inherited checks; human rejection remains available.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.add_artifact(:'lr'::uuid,'page','page_J','Summary',array[]::text[])->>'artifact_id' as summary \gset
select is(tests.error_of(format('select public.submit_for_review(%L::uuid,%L,array[%L::uuid])',:'lr','Done',:'summary')),'ci_commit_required','job delivery must name the final commit');
select ok(tests.detail_of(format('select public.submit_for_review(%L::uuid,%L,array[%L::uuid])',:'lr','Done',:'summary'))::jsonb->'checks' @> '["build","test"]','missing final commit explains inherited requirements');
select is(public.submit_for_review(:'lr'::uuid,'Done',array[:'final'::uuid])->>'task_state','ready_for_review','final diff permits delivery');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.close_task(%L::uuid,%L)',:'job','accepted')),'ci_pending','Accept waits for final checks');
select is(public.job_ci_status(:'job'::uuid)->>'state','pending','passing subtask commit does not prove final commit');
select is(tests.error_of(format('do $b$ begin perform public.close_task(%L::uuid,%L); raise exception ''rejection_allowed''; end $b$',:'job','rejected')),'rejection_allowed','rejection is never held by CI');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',201,'name','test','head_sha',repeat('f',40),'conclusion','success','html_url','https://github.com/acme/app/runs/201','completed_at',now()));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.close_task(%L::uuid,%L)',:'job','accepted')),'ci_pending','every final check must arrive');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',202,'name','build','head_sha',repeat('f',40),'conclusion','failure','html_url','https://github.com/acme/app/runs/202','completed_at',now()));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.close_task(%L::uuid,%L)',:'job','accepted')),'ci_failed','failed final check blocks Accept');
select tests.reset_role();
update public.ci_connections set revoked_at=now() where id=:'conn'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('do $b$ begin perform public.close_task(%L::uuid,%L); raise exception ''accept_allowed''; end $b$',:'job','accepted')),'accept_allowed','without live CI a person can accept');
select tests.reset_role();
update public.ci_connections set revoked_at=null where id=:'conn'::uuid;
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',203,'name','build','head_sha',repeat('f',40),'conclusion','success','html_url','https://github.com/acme/app/runs/203','completed_at',now()+interval '1 second'));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((select state from public.agent_tasks where id=:'job'::uuid),'ready_for_review','Balanced still needs a person after green CI');
select is(tests.error_of(format('do $b$ begin perform public.close_task(%L::uuid,%L); raise exception ''accept_allowed''; end $b$',:'job','accepted')),'accept_allowed','final CI green enables Accept');
select tests.reset_role();

-- Step 4: the Lead or authenticated CI delivery closes only eligible Autonomous jobs.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.close_job(%L::uuid)',:'job')),'lead_only','a person uses close_task instead');
select public.create_agent_task('page_X','{"objective":"Dependent"}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as dependent \gset
select tests.reset_role();
update public.agent_tasks set depends_on_task_ids=array[:'job'::uuid] where id=:'dependent'::uuid;
update public.agents set capabilities=capabilities || '{"start":true}' where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_job(%L::uuid)',:'job')),'lead_only','worker cannot close the job');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'job'))::jsonb->>'reason','autonomy','Balanced cannot close without a person');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'autonomous');
select tests.reset_role();
update public.agent_tasks set state='ready_for_review' where id=:'s2'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'job'))::jsonb->>'reason','subtasks_open','every subtask must be settled');
select tests.reset_role();
update public.agent_tasks set state='done' where id=:'s2'::uuid;
update public.task_briefs set done_when='[{"id":"h","text":"Person approves","check":"human","by":"person"}]' where task_id=:'job'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'job'))::jsonb->>'reason','human_criteria','a human criterion prevents automatic acceptance');
select tests.reset_role();
update public.task_briefs set done_when='[]' where task_id=:'job'::uuid;
update public.agent_tasks set state='cancelled' where parent_task_id=:'job'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('do $b$ begin perform public.close_job(%L::uuid); raise exception ''closed_without_ci''; end $b$',:'job')),'closed_without_ci','no CI never blocks Autonomous closure');
select tests.reset_role();
update public.agent_tasks set state='done' where parent_task_id=:'job'::uuid;
update public.agent_artifacts set ref='acme/app@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' where id=:'final'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'job'))::jsonb->>'reason','ci_pending','Lead receives a useful pending reason');
select tests.reset_role();
update public.agent_artifacts set ref='acme/app@ffffffffffffffffffffffffffffffffffffffff' where id=:'final'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(public.close_job(:'job'::uuid)->>'task_state','done','Lead closes delivered Autonomous job without an active run');
select tests.reset_role();
select is((select acceptance from public.agent_tasks where id=:'job'::uuid),'accepted','automatic close accepts');
select ok((select closed_by is null from public.agent_tasks where id=:'job'::uuid),'does not impersonate a person');
select ok(exists(select 1 from public.agent_activities where task_id=:'job'::uuid and body->>'rule'='ci_job' and author_type='agent'),'Lead closure is attributed');
select is((select state from public.agent_tasks where id=:'dependent'::uuid),'queued','dependent remains queued for claim');
select ok(exists(select 1 from public.agent_events where task_id=:'dependent'::uuid and payload->>'released_by'=:'job'),'closing emits dependent release');
-- Reuse the fixture in a new delivery state to exercise arrival after the Lead has gone.
update public.agent_tasks set state='ready_for_review',acceptance='pending',closed_at=null where id=:'job'::uuid;
update public.agent_artifacts set ref='acme/app@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' where id=:'final'::uuid;
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',301,'name','test','head_sha',repeat('e',40),'conclusion','success','html_url','https://github.com/acme/app/runs/301','head_branch','a/job','completed_at',now()));
select tests.reset_role();
select is((select state from public.agent_tasks where id=:'job'::uuid),'ready_for_review','first of two final checks does not close');
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',302,'name','build','head_sha',repeat('e',40),'conclusion','success','html_url','https://github.com/acme/app/runs/302','head_branch','a/job','completed_at',now()));
select is(public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',302,'name','build','head_sha',repeat('e',40),'conclusion','success','html_url','https://github.com/acme/app/runs/302','completed_at',now()))->>'recorded','false','replayed webhook is idempotent');
select tests.reset_role();
select is((select state from public.agent_tasks where id=:'job'::uuid),'done','last final check closes without a waiting agent');
select is((select count(*)::int from public.agent_activities where task_id=:'job'::uuid and body->>'rule'='ci_job' and author_type='system'),1,'server closure is attributed exactly once');

select ok(exists(select 1 from public.audit_events where action='task.close_job' and target->>'task_id'=:'job'),'automatic close is audited');
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',303,'name','test','head_sha',repeat('d',40),'conclusion','success','html_url','https://github.com/acme/app/runs/303','head_branch','a/job','completed_at',now()+interval '2 seconds'));
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.job_ci_status(:'job'::uuid)->>'newer_commit','ddddddd','branch movement is visible without changing final-commit evidence');
select is(public.job_ci_status(:'job'::uuid)->>'state','passed','new branch head does not replace the named final commit');
select tests.reset_role();

-- Step 9: the person settles human criteria once on the job, never through CI.
select tests.make_page((:'f'::jsonb->>'ws')::uuid,p,'page_A') from unnest(array['page_HJ','page_HS']) p;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_HJ','{"objective":"Human acceptance"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as hj \gset
select public.create_agent_task('page_HS','{"objective":"Design","done_when":[{"id":"h1","text":"Approve the design","check":"human"}]}',(:'f'::jsonb->>'agent')::uuid,:'hj'::uuid)->>'task_id' as hs \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'hs'::uuid,'custom')->>'run_id' as hr \gset
select public.add_artifact(:'hr'::uuid,'page','page_HS','Design',array['h1'])->>'artifact_id' as ha \gset
select public.submit_for_review(:'hr'::uuid,'Design delivered',array[:'ha'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'hj'::uuid,'custom')->>'run_id' as hlr \gset
select public.review_task(:'hs'::uuid,'approved','[{"criterion_id":"h1","status":"unverified"}]','[]',null,:'hlr'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'hs')),'policy_denied','person criterion remains for job Accept');
select is(public.job_ci_status(:'hj'::uuid)->'pending_human',jsonb_build_array(jsonb_build_object('criterion_id','h1','text','Approve the design','task_id',:'hs')),'job exposes the person criterion');
select public.add_artifact(:'hlr'::uuid,'page','page_HJ','Final design',array[]::text[])->>'artifact_id' as hja \gset
select public.submit_for_review(:'hlr'::uuid,'Ready',array[:'hja'::uuid]);
select is(tests.error_of(format('select public.close_job(%L::uuid)',:'hj')),'policy_denied','agent never settles the person criterion');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.close_task(:'hj'::uuid,'accepted')->>'task_state','done','one human Accept settles the job');
select is(public.job_ci_status(:'hj'::uuid)->'pending_human','[]'::jsonb,'accepted job has no pending human criteria');
select tests.reset_role();

-- CI can finish while the Lead is still working: delivery must recheck eligibility.
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'page_EarlyCI','page_A');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_EarlyCI','{"objective":"CI before delivery","done_when":[{"id":"c1","text":"Tests pass","check":"ci","command":"test"},{"id":"c2","text":"Build passes","check":"ci","command":"build"}]}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as early_job \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'early_job'::uuid,'custom')->>'run_id' as early_run \gset
select public.add_artifact(:'early_run'::uuid,'diff','acme/app@9999999999999999999999999999999999999999','Final commit',array['c1','c2'])->>'artifact_id' as early_diff \gset
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',run_id,'name',check_name,'head_sha',repeat('9',40),'conclusion','success','html_url','https://github.com/acme/app/runs/' || run_id,'completed_at',now()))
  from (values (401,'test'),(402,'build')) checks(run_id,check_name);
select tests.reset_role();
select is((select state from public.agent_tasks where id=:'early_job'::uuid),'working','early passing checks do not close an undelivered job');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.job_ci_status(:'early_job'::uuid)->>'state','passed','both final checks are already green before submission');
select is(public.submit_for_review(:'early_run'::uuid,'Ready',array[:'early_diff'::uuid])->>'task_state','done','submission closes a job whose final checks already passed');
select tests.reset_role();
select is((select state from public.agent_tasks where id=:'early_job'::uuid),'done','early CI closure is persisted');
select is((select acceptance from public.agent_tasks where id=:'early_job'::uuid),'accepted','early CI delivery is accepted');
select is((select count(*)::int from public.agent_activities where task_id=:'early_job'::uuid and body->>'rule'='ci_job'),1,'early CI creates exactly one closure activity');
select is((select author_type from public.agent_activities where task_id=:'early_job'::uuid and body->>'rule'='ci_job'),'system','early CI closure is attributed to the system');
select is((select count(*)::int from public.audit_events where action='task.close_job' and target->>'task_id'=:'early_job' and target->>'by'='ci'),1,'early CI closure is audited exactly once');
select * from finish();
rollback;
