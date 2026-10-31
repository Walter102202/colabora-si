begin;
select plan(25);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid,p,'page_A') from unnest(array['fence_p','fence_s','fence_n','fence_w','fence_db']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'agent+fencelead@agents.invalid','lead','page_A') as lead \gset
select set_config('app.ops_write','1',true);
update public.pages set data=data||'{"database":{"properties":[{"id":"title","name":"Title","type":"text"}],"rows":[{"id":"row","pageId":"fence_w","cells":{}}]}}'::jsonb where id='fence_db';
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('fence_p','{"objective":"Parent","policies":{"subtask_close":"lead"}}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as parent \gset
select public.create_agent_task('fence_s','{"objective":"Child","done_when":[{"id":"c","text":"Deliver","check":"lead"}]}',(:'f'::jsonb->>'agent')::uuid,:'parent'::uuid)->>'task_id' as child \gset
select public.create_agent_task('fence_w','{"objective":"Worker","policies":{"preapproved":["email.send"]}}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as worker \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid,'codex')->>'run_id' as lr \gset
select public.reserve_environment(:'child'::uuid,'[{"kind":"stack","value":"fence-test"}]');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'worker'::uuid,'codex')->>'run_id' as wr \gset
select public.begin_external_op(:'wr'::uuid,'smtp','email.send','{"n":1}')->>'op_id' as done_op \gset
select public.finish_external_op(:'done_op'::uuid,'done','ref');
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'done_op','failed','rewrite')),'invalid_state','completed operations are immutable even in an active run');
select public.begin_external_op(:'wr'::uuid,'smtp','email.send','{"n":2}')->>'op_id' as pending_op \gset
select public.claim_task(:'child'::uuid,'codex')->>'run_id' as cr \gset
select public.add_artifact(:'cr'::uuid,'page','fence_s','Delivered',array['c'])->>'artifact_id' as art \gset
select public.submit_for_review(:'cr'::uuid,'Done',array[:'art'::uuid]);
select tests.reset_role();
-- A parent with open children is a valid silent wait, even without a persisted wait target.
update public.agent_runs set last_signal_at=now()-interval '121 minutes' where id in (:'lr'::uuid,:'wr'::uuid);
update public.agent_runs set waiting_on_task_id=task_id where id=:'wr'::uuid;
select private.agent_housekeeping();
select is((select status from public.agent_runs where id=:'lr'::uuid),'running','open children protect a parent lease');
select is((select status from public.agent_runs where id=:'wr'::uuid),'cancelled','waiting on oneself never protects an expired lease');
-- Simulate the parent losing its run as a handover would; child resources still require a current Lead session.
update public.agent_runs set status='cancelled',ended_at=now() where id=:'lr'::uuid;
update public.agent_tasks set active_run_id=null,state='queued' where id=:'parent'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'done_op','failed','late')),'run_not_active','dead runs cannot rewrite finished operations');
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'pending_op','done','late')),'forbidden','detached unknown operations cannot be completed by the old session');
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'worker','{"next_step":"late"}')),'run_not_active','delegate brief edits require its active run');
select is(tests.error_of('select public.append_page_blocks(''fence_w'',''[{"type":"paragraph","spans":["late"]}]''::jsonb)'),'run_not_active','task page writes require its active assigned run');
select is(tests.error_of('select public.set_row_cells(''fence_db'',''row'',''{"title":{"text":"late"}}''::jsonb)'),'run_not_active','database cell writes cannot bypass the assigned row fence');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.close_subtask(%L::uuid)',:'child')),'run_not_active','expired Lead cannot close a delivery');
select is(tests.error_of(format('select public.create_subtask(%L::uuid,%L,%L::jsonb)',:'parent','fence_n','{"objective":"Late"}')),'run_not_active','expired Lead cannot create a child');
select is(tests.error_of(format('select public.create_agent_task(%L,%L::jsonb,%L::uuid,%L::uuid)','fence_n','{"objective":"Direct bypass"}',(:'f'::jsonb->>'agent'),:'parent')),'run_not_active','direct task creation cannot bypass the Lead fence');
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'child','{"objective":"Late"}')),'run_not_active','expired Lead cannot edit a child');
select is(tests.error_of(format('select public.reserve_environment(%L::uuid,%L::jsonb)',:'child','[{"kind":"branch","value":"a/late"}]')),'run_not_active','expired Lead cannot reserve');
select is(tests.error_of(format('select public.release_environment(%L::uuid)',:'child')),'run_not_active','expired Lead cannot confirm release');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select ok(public.release_environment(:'child'::uuid)->>'released'='1','a human can still release the resources');
select tests.reset_role();
-- A persisted wait on an unrelated open task is not a child wait.
update public.agent_runs set status='running',ended_at=null,stop_requested_at=null,stale_at=null,waiting_on_task_id=:'parent'::uuid where id=:'wr'::uuid;
update public.agent_tasks set active_run_id=:'wr'::uuid,state='working' where id=:'worker'::uuid;
select private.agent_housekeeping();
select is((select status from public.agent_runs where id=:'wr'::uuid),'cancelled','waiting on another task never protects a silent lease');
-- Closure cleanup does not depend on active_run_id remaining attached.
update public.agent_tasks set state='done',active_run_id=null where id=:'parent'::uuid;
update public.agent_runs set status='running',ended_at=null,stop_requested_at=null where id=:'lr'::uuid;
select private.agent_housekeeping();
select is((select status from public.agent_runs where id=:'lr'::uuid),'completed','housekeeping ends runs whose task closed');
select isnt((select ended_at from public.agent_runs where id=:'lr'::uuid),null,'terminal runs receive an end timestamp');

-- A stop fences new effects but must not hide the result of an effect already attempted.
select tests.reset_role();
update public.agent_runs set last_signal_at=now(),error_message=null,status='running',ended_at=null,stop_requested_at=null,stale_at=null where id=:'wr'::uuid;
update public.agent_tasks set active_run_id=:'wr'::uuid,state='working' where id=:'worker'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.begin_external_op(:'wr'::uuid,'smtp','email.send','{"n":31}')->>'op_id' as stopped_op \gset
select public.begin_external_op(:'wr'::uuid,'smtp','email.send','{"n":32}')->>'op_id' as acked_op \gset
select tests.reset_role();
update public.agent_runs set stop_requested_at=now() where id=:'wr'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'stopped_op','done','sent')) ,'','a run with stop requested can report an already attempted effect');
select is(tests.error_of(format('select public.begin_external_op(%L::uuid,%L,%L,%L::jsonb)',:'wr','smtp','email.send','{"n":33}')),'run_not_active','the same stopped run cannot start a new effect');
select public.ack_stop(:'wr'::uuid);
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'acked_op','unknown','attempted')),'','an acknowledged stop permits one final uncertain outcome');
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'acked_op','done','again')),'invalid_state','the final stopped-run outcome is recorded only once');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.finish_external_op(%L::uuid,%L,%L)',:'acked_op','done','wrong-agent')),'forbidden','another agent cannot report the stopped operation');
select tests.reset_role();
-- AI requests on the same page use their own run-bound mutation RPCs and do not lock normal page work.
update public.agent_runs set last_signal_at=now(),error_message=null,status='running',ended_at=null,stop_requested_at=null,stale_at=null where id=:'wr'::uuid;
update public.agent_tasks set active_run_id=:'wr'::uuid,state='working' where id=:'worker'::uuid;
insert into public.agent_tasks(workspace_id,context_id,row_page_id,title,delegate_agent_id,owner_user_id,created_by,created_by_type,state,request_kind)
select workspace_id,context_id,row_page_id,'Queued rewrite',delegate_agent_id,owner_user_id,created_by,created_by_type,'queued','rewrite' from public.agent_tasks where id=:'worker'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of('select public.append_page_blocks(''fence_w'',''[{"type":"paragraph","spans":["live"]}]''::jsonb)'),'','a queued AI request does not block the live task writer');
select tests.reset_role();
update public.agent_tasks set delegate_agent_id=(:'lead'::jsonb->>'agent')::uuid,state='working',active_run_id=:'cr'::uuid where id=:'child'::uuid;
update public.agent_runs set agent_id=(:'lead'::jsonb->>'agent')::uuid,status='running',ended_at=null,stop_requested_at=null where id=:'cr'::uuid;
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'child','{"next_step":"Continue my own child"}')),'','a Lead can update its own live subtask without a parent run');
select tests.reset_role();

select * from finish();
rollback;
