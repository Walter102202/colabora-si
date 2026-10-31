begin;
select plan(21);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset

-- The Lead takes the parent task and delegates a subtask to the worker.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Ship the report"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A2', '{"objective":"Write the report"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset

-- Round 1: the worker delivers, the Lead asks for changes.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A2', 'Report', '{}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'art'::uuid]);

select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.review_task(%L::uuid, %L)', :'sub', 'approved')), 'forbidden',
          'review_task outside a run of the Lead on the parent is refused');
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid) as rv1 \gset
select is(:'rv1'::jsonb ->> 'rounds', '1', 'the first review counts one round');
select is(:'rv1'::jsonb ->> 'task_state', 'queued', 'the subtask goes back to the queue');

-- Rounds 2 and 3.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w2 \gset
select public.submit_for_review(:'w2'::uuid, 'v2', array[:'art'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as w3 \gset
select public.submit_for_review(:'w3'::uuid, 'v3', array[:'art'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'sub'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);

-- The third request for changes escalates to a person.
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'sub'::uuid), 'input_required', 'the third round escalates');
select is((select waiting_on from public.agent_tasks where id = :'sub'::uuid), 'human', 'the escalation waits on a person');
select ok(exists (select 1 from public.notifications where task_id = :'sub'::uuid and kind = 'escalation'), 'the owner gets an escalation notification');
select is((select review_rounds from public.agent_tasks where id = :'sub'::uuid), 3, 'three rounds were counted');

-- Brief patches preserve policy keys and the safeguards of task creation/handover.
select tests.reset_role();
select tests.make_page((:'f'::jsonb->>'ws')::uuid,p,'page_A') from unnest(array['patch_a','patch_b','patch_c']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'agent+replacement@agents.invalid','worker','page_A') as replacement \gset
update public.agents set capabilities=capabilities||'{"resume":true,"continue":true}' where id=(:'replacement'::jsonb->>'agent')::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.create_subtask(:'parent'::uuid,'patch_a','{"objective":"Patch A","policies":{"require_approval":["git.merge","deploy"],"lease_minutes":90}}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as pa \gset
select public.create_subtask(:'parent'::uuid,'patch_b','{"objective":"Patch B"}',null,'{}',array[:'pa'::uuid])->>'task_id' as pb \gset
select public.create_subtask(:'parent'::uuid,'patch_c','{"objective":"Patch C"}',null,'{}',array[:'pb'::uuid])->>'task_id' as pc \gset
select public.update_brief(:'pa'::uuid,'{"policies":{"lease_minutes":60}}');
select is((select policies->'require_approval' from public.task_briefs where task_id=:'pa'::uuid order by version desc limit 1),'["git.merge","deploy"]'::jsonb,'a partial policy update preserves approval requirements');
select tests.reset_role();
update public.task_briefs set policies=policies||'{"require_approval":["git.merge","deploy"]}' where task_id=:'pa'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'pa','{"policies":{"require_approval":["deploy"]}}')),'approval_policy_locked','an agent cannot remove one required action');
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'pa','{"policies":{"require_approval":null}}')),'approval_policy_locked','an agent cannot clear approval requirements');
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'pa',jsonb_build_object('depends_on_task_ids',array[:'pb']))),'invalid_dependency','direct dependency cycles are refused');
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'pa',jsonb_build_object('depends_on_task_ids',array[:'pc']))),'invalid_dependency','transitive dependency cycles are refused');
select tests.reset_role();
update public.agent_tasks set depends_on_task_ids='{}' where id=:'pa'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'pa'::uuid,'codex')->>'run_id' as old_run \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.update_brief(:'pa'::uuid,jsonb_build_object('delegate_agent_id',:'replacement'::jsonb->>'agent'));
select tests.reset_role();
select is((select status from public.agent_runs where id=:'old_run'::uuid),'cancelled','reassignment fences the old active run');
select is((select state from public.agent_tasks where id=:'pa'::uuid),'queued','reassignment makes the stuck task claimable');
select ok(exists(select 1 from public.agent_events where task_id=:'pa'::uuid and type='task.stop' and run_id=:'old_run'::uuid),'the old executor gets a stop event');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.add_artifact(%L::uuid,%L,%L,%L)',:'old_run','page','patch_a','Late')),'run_not_active','old executor cannot deliver after reassignment');
select is(tests.error_of('select public.append_page_blocks(''patch_a'',''[{"type":"paragraph","spans":["late old writer"]}]''::jsonb)'),'run_not_active','former delegate grants cannot bypass reassignment fencing');
select tests.reset_role();
select tests.set_agent((:'replacement'::jsonb->>'user')::uuid,(:'replacement'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid,%L,null,null,true)',:'pa','codex')),'','replacement can resume the reassigned task');
select tests.reset_role();
update public.agent_runs set cost_usd=5 where id=:'old_run'::uuid;
update public.agents set monthly_budget_usd=1 where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'pb',jsonb_build_object('delegate_agent_id',:'f'::jsonb->>'agent'))),'budget_exceeded','reassignment enforces the creation budget guard');
select tests.reset_role();
update public.agent_tasks set state='done',acceptance='accepted' where id=:'pb'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'pb','{"objective":"After closure"}')),'invalid_state','agents cannot edit closed tasks');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select ok(public.update_brief(:'pb'::uuid,'{"objective":"Human correction"}')>1,'a human can still correct the historical brief');
select tests.reset_role();

select * from finish();
rollback;
