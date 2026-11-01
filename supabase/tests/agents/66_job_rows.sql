-- People add rows; a Lead adopts them without changing the chosen Worker or page.
begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'rows-lead@agents.invalid','lead','page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'rows-other@agents.invalid','worker','page_A') as other \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'rows-db',null,'{"id":"rows-db","title":"Human jobs","blocks":[],"database":{"properties":[{"id":"status","type":"agentStatus"}],"rows":[{"id":"job","pageId":"rows-job"},{"id":"sub1","pageId":"rows-sub1","parentRowId":"job"},{"id":"sub2","pageId":"rows-sub2","parentRowId":"job"}]}}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'rows-job','rows-db','{"id":"rows-job","title":"Research","blocks":[]}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'rows-sub1','rows-db','{"id":"rows-sub1","title":"Keep my subtask","blocks":[{"id":"note","type":"paragraph","html":"My plan"}]}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'rows-sub2','rows-db','{"id":"rows-sub2","title":"Lead chooses","blocks":[]}');
insert into public.agent_connections(workspace_id,agent_id,page_id,created_by,verified_at)
select (:'f'::jsonb->>'ws')::uuid,id,'page_A',(:'f'::jsonb->>'owner')::uuid,now() from public.agents where workspace_id=(:'f'::jsonb->>'ws')::uuid;
insert into public.agent_oauth_links(user_id,client_id,as_human) values ((:'f'::jsonb->>'owner')::uuid,'rows-chat',true);
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.set_subtask_worker(%L,%L)','rows-sub1',:'f'::jsonb->>'agent')),'humans_only','agent cannot choose human row Worker');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid,'rows-chat');
select is(tests.error_of(format('select public.set_subtask_worker(%L,%L)','rows-sub1',:'f'::jsonb->>'agent')),'direct_session_required','chat cannot choose Worker');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format('select public.set_subtask_worker(%L,%L)','rows-sub1',:'f'::jsonb->>'agent')),'forbidden','viewer cannot choose Worker');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.set_subtask_worker(%L,%L)','rows-sub1',:'f'::jsonb->>'agent')),'42501','anon cannot choose Worker');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.set_subtask_worker(%L,%L)','rows-job',:'f'::jsonb->>'agent')),'not_a_subtask','top-level job is not a pending subtask');
select public.set_subtask_worker('rows-sub1',(:'f'::jsonb->>'agent')::uuid) as choice \gset
select is(jsonb_array_length(:'choice'::jsonb->'granted_agents'),1,'choice reports newly granted database access');
select public.assign_job('rows-job',(:'lead'::jsonb->>'agent')::uuid,'{}')->>'task_id' as job \gset
select tests.reset_role();
select is((select worker_agent_id from public.agent_row_plans where row_page_id='rows-sub1'),(:'f'::jsonb->>'agent')::uuid,'human Worker persisted');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format('insert into public.agent_row_plans(row_page_id,workspace_id,updated_by) values(%L,%L,%L)','rows-sub2',:'f'::jsonb->>'ws',:'f'::jsonb->>'owner')),'42501','direct plan writes forbidden');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(public.get_pending_job_rows(:'job'::uuid),'[]'::jsonb,'Worker does not receive Lead adoption queue');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(jsonb_array_length(public.get_pending_job_rows(:'job'::uuid)),2,'Lead sees planned rows with and without Worker choice');
select is(jsonb_array_length(public.join_job('Research','Lead')->'pending_rows'),2,'join includes pending human rows');
select public.claim_task(:'job'::uuid,'custom')->>'run_id' as run \gset
select is(tests.error_of(format('select public.create_subtask(%L,%L,%L::jsonb,%L)',:'job','rows-sub1','{"objective":"Adopt"}',:'other'::jsonb->>'agent')),'worker_chosen_by_person','Lead cannot override chosen Worker');
select is(tests.error_of(format('select public.create_agent_task(%L,%L::jsonb,%L,%L)','rows-sub1','{"objective":"Bypass"}',:'other'::jsonb->>'agent',:'job')),'worker_chosen_by_person','generic task RPC cannot bypass chosen Worker');
select is(tests.error_of(format('select public.create_agent_task(%L,%L::jsonb,%L)','rows-sub1','{"objective":"Orphan"}',:'f'::jsonb->>'agent')),'parent_required','pending human row cannot become an unrelated task');
select public.create_subtask(:'job'::uuid,'rows-sub1','{"objective":"Adopt"}') ->>'task_id' as adopted \gset
select is(jsonb_array_length(public.get_pending_job_rows(:'job'::uuid)),1,'adopted row leaves queue');
select is(tests.error_of(format('select public.update_brief(%L,%L::jsonb)',:'adopted',jsonb_build_object('delegate_agent_id',(:'other'::jsonb->>'agent')::uuid))),'worker_chosen_by_person','later reassignment cannot bypass human Worker');
select tests.reset_role();
select is((select delegate_agent_id from public.agent_tasks where id=:'adopted'::uuid),(:'f'::jsonb->>'agent')::uuid,'omitted delegate preserves human Worker');
select is((select data->>'title' from public.pages where id='rows-sub1'),'Keep my subtask','adoption preserves human title');
select is((select data->'blocks'->0->>'html' from public.pages where id='rows-sub1'),'My plan','adoption preserves human plan');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.set_subtask_worker(%L,%L)','rows-sub1',:'other'::jsonb->>'agent')),'subtask_started','adopted queued row is locked');
select tests.reset_role();
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values ('rows-sub2',(:'f'::jsonb->>'ws')::uuid,(:'f'::jsonb->>'owner')::uuid,'rows-sub2');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(public.get_pending_job_rows(:'job'::uuid),'[]'::jsonb,'private pending rows never reach Lead');
select tests.reset_role();
delete from public.private_pages where page_id='rows-sub2';
select tests.make_user('rows-outsider@test.local') as outsider \gset
select tests.set_human(:'outsider'::uuid);
select is((select count(*)::int from public.agent_row_plans),0,'outsider cannot read row plans');
select is(tests.error_of(format('select public.set_subtask_worker(%L,%L)','rows-sub2',:'f'::jsonb->>'agent')),'forbidden','outsider cannot change row plans');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_subtask_worker('rows-sub2',(:'other'::jsonb->>'agent')::uuid);
select public.set_subtask_worker('rows-sub2',null);
select tests.reset_role();
select is((select worker_agent_id from public.agent_row_plans where row_page_id='rows-sub2'),null::uuid,'person can return an unadopted row to Lead chooses');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.create_subtask(:'job'::uuid,'rows-sub2','{"objective":"Do it myself"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as self_task \gset
select tests.reset_role();
select is((select delegate_agent_id from public.agent_tasks where id=:'self_task'::uuid),(:'lead'::jsonb->>'agent')::uuid,'Lead can work without a Worker');
select * from finish();
rollback;
