begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid,p,'page_A') from unnest(array['auto_job','auto_person','auto_ci','auto_lead']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'agent+autoclose@agents.invalid','lead','page_A') as lead \gset
insert into public.agent_workspace_policies(workspace_id,autonomy) values ((:'f'::jsonb->>'ws')::uuid,'autonomous') on conflict(workspace_id) do update set autonomy='autonomous';
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'autonomous');
select public.create_agent_task('auto_job','{"objective":"Ship autonomously"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as job \gset
select public.create_agent_task('auto_person','{"objective":"Person criterion","done_when":[{"id":"p","text":"I want to see it","check":"human","by":"agent"}]}',(:'f'::jsonb->>'agent')::uuid,:'job'::uuid)->>'task_id' as person_task \gset
select is((select done_when#>>'{0,by}' from public.task_briefs where task_id=:'person_task'::uuid),'person','person creation overrides forged authorship');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job'::uuid,'custom')->>'run_id' as lr \gset
select public.update_brief(:'person_task'::uuid,'{"done_when":[{"id":"p","text":"I want to see it","check":"human","by":"agent"},{"id":"a","text":"Agent suggestion","check":"human","by":"person"}]}');
select is((select done_when#>>'{0,by}' from public.task_briefs where task_id=:'person_task'::uuid and version=2),'person','unchanged id and text retain person authorship');
select is((select done_when#>>'{1,by}' from public.task_briefs where task_id=:'person_task'::uuid and version=2),'agent','agent additions cannot forge person authorship');
select tests.reset_role();
-- A person's human criterion cannot be accepted by the Lead, even with evidence.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'person_task'::uuid,'custom')->>'run_id' as pr \gset
select public.add_artifact(:'pr'::uuid,'page','auto_person','Screen',array['p','a'])->>'artifact_id' as pa \gset
select public.submit_for_review(:'pr'::uuid,'Ready',array[:'pa'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'person_task'::uuid,'approved','[{"criterion_id":"p","status":"verified","evidence_ref":"screenshot:1"},{"criterion_id":"a","status":"verified","evidence_ref":"screenshot:1"}]','[]',null,:'lr'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'person_task')),'policy_denied','person criterion needs the person');
select public.add_artifact(:'lr'::uuid,'page','auto_job','Delivery',array[]::text[])->>'artifact_id' as ja \gset
select public.submit_for_review(:'lr'::uuid,'Ready for the requested look',array[:'ja'::uuid]);
select is(tests.error_of(format('select public.close_job(%L::uuid)',:'job')),'policy_denied','job cannot bypass the person criterion');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.close_task(:'job'::uuid,'accepted')->>'task_state','done','one job Accept settles the person criterion');
select is(public.job_ci_status(:'job'::uuid)->'pending_human','[]'::jsonb,'person criterion is settled once');
select tests.reset_role();

-- (i) All person setup precedes job creation. From creation to close: only Lead and worker calls.
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'auto_e2e','page_A');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('auto_e2e','{"objective":"Two deliveries, zero person calls"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as e2e \gset
select tests.reset_role();
select count(*) as person_calls from public.audit_events where actor_type='human' \gset
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'e2e'::uuid,'custom')->>'run_id' as er \gset
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'e2e'))::jsonb->>'reason','not_delivered','working job cannot close');
select public.create_subtask(:'e2e'::uuid,'auto_ci','{"objective":"Tests pass","done_when":[{"id":"c","text":"Tests pass","check":"ci","command":"test"}]}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as ci_task \gset
select public.create_subtask(:'e2e'::uuid,'auto_lead','{"objective":"Screen","done_when":[{"id":"l","text":"Screen works","check":"lead"},{"id":"h","text":"Look at the screen","check":"human"},{"id":"d","text":"Local check","check":"deterministic","command":"npm test"}]}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as lead_task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ci_task'::uuid,'custom')->>'run_id' as cr \gset
select public.add_artifact(:'cr'::uuid,'diff','acme/app@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','CI run',array['c'])->>'artifact_id' as ca \gset
select public.submit_for_review(:'cr'::uuid,'Tests passed',array[:'ca'::uuid]);
select public.claim_task(:'lead_task'::uuid,'custom')->>'run_id' as wr \gset
select public.add_artifact(:'wr'::uuid,'page','auto_lead','Screen',array['l','h','d'])->>'artifact_id' as wa \gset
select public.submit_for_review(:'wr'::uuid,'Screen delivered',array[:'wa'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'ci_task')),'policy_denied','review is required');
select public.review_task(:'ci_task'::uuid,'approved','[{"criterion_id":"c","status":"verified"}]','[]',null,:'er'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'ci_task')),'policy_denied','verified without evidence_ref cannot close');
select public.review_task(:'ci_task'::uuid,'approved','[{"criterion_id":"c","status":"verified","evidence_ref":"  "}]','[]',null,:'er'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'ci_task')),'policy_denied','blank evidence_ref cannot close');
select public.review_task(:'ci_task'::uuid,'approved','[{"criterion_id":"c","status":"verified","evidence_ref":"https://github.com/acme/app/runs/1"}]','[]',null,:'er'::uuid);
select tests.reset_role();
update public.agent_reviews set reviewer_id=(:'f'::jsonb->>'agent')::uuid where task_id=:'ci_task'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'ci_task')),'policy_denied','self review never closes');
select tests.reset_role();
update public.agent_reviews set reviewer_id=(:'lead'::jsonb->>'agent')::uuid where task_id=:'ci_task'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.close_subtask(:'ci_task'::uuid),'{"task_state":"done"}'::jsonb,'(a) no connection closes with evidence, without a ci key');
select public.review_task(:'lead_task'::uuid,'approved','[{"criterion_id":"l","status":"verified","evidence_ref":"screenshot:1"},{"criterion_id":"h","status":"verified","evidence_ref":"screenshot:1"},{"criterion_id":"d","status":"verified","evidence_ref":"npm test"}]','[]',null,:'er'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'lead_task')),'policy_denied','deterministic still requires evidence naming command');
select public.review_task(:'lead_task'::uuid,'approved','[{"criterion_id":"l","status":"verified","evidence_ref":"screenshot:1"},{"criterion_id":"h","status":"unverified","evidence_ref":"screenshot:1"},{"criterion_id":"d","status":"verified","evidence_ref":"npm test"}]','[{"kind":"command","ref":"npm test"}]',null,:'er'::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'lead_task')),'policy_denied','agent human suggestion still needs verified finding');
select public.review_task(:'lead_task'::uuid,'approved','[{"criterion_id":"l","status":"verified","evidence_ref":"screenshot:1"},{"criterion_id":"h","status":"verified","evidence_ref":"screenshot:1"},{"criterion_id":"d","status":"verified","evidence_ref":"npm test"}]','[{"kind":"command","ref":"npm test"}]',null,:'er'::uuid);
select is(public.close_subtask(:'lead_task'::uuid),'{"task_state":"done"}'::jsonb,'(c) screenshot proves agent human suggestion; deterministic and lead close');
select public.add_artifact(:'er'::uuid,'diff','acme/app@ffffffffffffffffffffffffffffffffffffffff','Final commit',array[]::text[])->>'artifact_id' as final \gset
select is(public.submit_for_review(:'er'::uuid,'All done',array[:'final'::uuid])->>'task_state','ready_for_review','no-connection delivery remains available for Lead close');
select is(public.close_job(:'e2e'::uuid)->>'task_state','done','(i) Lead closes entire Autonomous job');
select tests.reset_role();
select is((select count(*) from public.audit_events where actor_type='human'),:'person_calls'::bigint,'zero person calls after job creation');
select ok(exists(select 1 from public.agent_activities where task_id=:'e2e'::uuid and author_type='agent' and body->>'rule'='ci_job'),'(g) job close is agent-attributed');
select ok(exists(select 1 from public.audit_events where action='task.close_job' and target->>'task_id'=:'e2e'),'job close is audited');
select ok((select closed_by is null and acceptance='accepted' from public.agent_tasks where id=:'e2e'::uuid),'agent never impersonates a person');

-- Reuse delivered state to test live connection vetoes and unchanged Balanced semantics.
update public.agent_tasks set state='ready_for_review',acceptance='pending',closed_at=null where id in (:'ci_task'::uuid,:'e2e'::uuid);
update public.agent_tasks set active_run_id=:'er'::uuid where id=:'e2e'::uuid;
update public.agent_runs set status='running' where id=:'er'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_ci_connection((:'f'::jsonb->>'ws')::uuid,'acme/app')->>'id' as conn \gset
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',601,'name','test','head_sha',repeat('a',40),'conclusion','failure','html_url','https://github.com/acme/app/runs/601','completed_at',now()));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_subtask(%L::uuid)',:'ci_task'))::jsonb->>'reason','ci_failed','(b) live failed check vetoes reviewed evidence');
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'e2e'))::jsonb->>'reason','subtasks_open','open subtask blocks job');
select tests.reset_role();
update public.ci_connections set revoked_at=now() where id=:'conn'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
-- close_subtask requires the parent active run; restore the fixture's working run only for this check.
select tests.reset_role();
update public.agent_tasks set state='working',active_run_id=:'er'::uuid where id=:'e2e'::uuid;
update public.agent_runs set status='running' where id=:'er'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.close_subtask(:'ci_task'::uuid)->>'task_state','done','revoked connection failure is ignored');
select tests.reset_role();
update public.agent_tasks set state='ready_for_review',active_run_id=null where id=:'e2e'::uuid;
update public.ci_connections set revoked_at=null where id=:'conn'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'e2e'))::jsonb->>'reason','ci_pending','pending final check waits');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',602,'name','test','head_sha',repeat('f',40),'conclusion','failure','html_url','https://github.com/acme/app/runs/602','completed_at',now()));
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'e2e'))::jsonb->>'reason','ci_failed','failed final check vetoes close_job');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'balanced');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'e2e'))::jsonb->>'reason','autonomy','(h) Balanced cannot close_job');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid,'autonomous');
select tests.reset_role();
select tests.set_service();
select public.record_ci_check(:'conn'::uuid,'acme/app',jsonb_build_object('id',603,'name','test','head_sha',repeat('f',40),'conclusion','success','html_url','https://github.com/acme/app/runs/603','completed_at',now()+interval '1 second'));
select tests.reset_role();
select is((select state from public.agent_tasks where id=:'e2e'::uuid),'done','passing delivery automatically closes pending job');
update public.agent_tasks set state='ready_for_review',acceptance='pending' where id=:'e2e'::uuid;
update public.agent_tasks set state='cancelled' where id=:'lead_task'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.detail_of(format('select public.close_job(%L::uuid)',:'e2e'))::jsonb->>'reason','subtasks_open','every subtask must be done and accepted');
select tests.reset_role();
update public.agent_tasks set state='done' where id=:'lead_task'::uuid;
update public.agent_artifacts set ref='no-commit' where id=:'final'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.job_ci_status(:'e2e'::uuid)->>'state','no_commit','no_commit fixture');
select is(tests.error_of(format('do $b$ begin perform public.close_job(%L::uuid); raise exception ''closed''; end $b$',:'e2e')),'closed','no_commit never blocks closure');
select tests.reset_role();
update public.task_briefs set done_when='[]' where task_id=:'ci_task'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.job_ci_status(:'e2e'::uuid)->>'state','none','none fixture');
select is(public.close_job(:'e2e'::uuid)->>'task_state','done','none never blocks closure');
select tests.reset_role();
select * from finish();
rollback;
