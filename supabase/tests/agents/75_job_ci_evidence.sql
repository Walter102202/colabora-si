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
select public.review_task(:'s1'::uuid,'approved','[{"criterion_id":"c1","status":"unverified"}]','[]',null,:'lr'::uuid);
select tests.reset_role();
update public.ci_connections set revoked_at=now() where id=:'conn'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.close_subtask(:'s1'::uuid) as closed \gset
select is(:'closed'::jsonb->>'task_state','done','unconnected CI does not strand reviewed work');
select is(:'closed'::jsonb->>'ci','deferred_to_job','CI is explicitly deferred');
select is(:'closed'::jsonb->'deferred_checks'->0->>'check','test','deferred result names the check');
select tests.reset_role();
select ok(exists(select 1 from public.agent_activities where task_id=:'s1'::uuid and body->>'rule'='ci_deferred'),'history records deferral');
select ok(exists(select 1 from public.agent_events where task_id=:'job'::uuid and payload ? 'ci_deferred'),'Lead event records deferral');
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
select is(public.close_subtask(:'s1'::uuid)->>'ci','deferred_to_job','connected but pending CI is deferred too');
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
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'s1')),'policy_denied','passing CI retains the verified-finding requirement');
select public.review_task(:'s1'::uuid,'approved','[{"criterion_id":"c1","status":"verified"}]','[]',null,:'lr'::uuid);
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
select * from finish();
rollback;
