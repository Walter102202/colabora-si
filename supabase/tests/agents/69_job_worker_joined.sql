-- A named Worker that takes a subtask has joined its job, with or without join_job.
begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'joined-lead@agents.invalid','lead','page_A') as lead \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'joined-db',null,'{"id":"joined-db","title":"Joined jobs","blocks":[],"database":{"properties":[{"id":"status","type":"agentStatus"}],"rows":[{"id":"job","pageId":"joined-job"},{"id":"sub1","pageId":"joined-sub1","parentRowId":"job"},{"id":"sub2","pageId":"joined-sub2","parentRowId":"job"},{"id":"sub3","pageId":"joined-sub3","parentRowId":"job"}]}}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'joined-job','joined-db','{"id":"joined-job","title":"Research","blocks":[]}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'joined-sub1','joined-db','{"id":"joined-sub1","title":"First","blocks":[]}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'joined-sub2','joined-db','{"id":"joined-sub2","title":"Second","blocks":[]}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'joined-sub3','joined-db','{"id":"joined-sub3","title":"Third","blocks":[]}');
insert into public.agent_connections(workspace_id,agent_id,page_id,created_by,verified_at)
select (:'f'::jsonb->>'ws')::uuid,id,'page_A',(:'f'::jsonb->>'owner')::uuid,now() from public.agents where workspace_id=(:'f'::jsonb->>'ws')::uuid;

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.assign_job('joined-job',(:'lead'::jsonb->>'agent')::uuid,array[(:'f'::jsonb->>'agent')::uuid])->>'task_id' as job \gset
select tests.reset_role();

select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job'::uuid,'custom')->>'run_id' as lead_run \gset
select public.create_subtask(:'job'::uuid,'joined-sub1','{"objective":"First"}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as first \gset
select public.create_subtask(:'job'::uuid,'joined-sub2','{"objective":"Second"}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as second \gset
select public.create_subtask(:'job'::uuid,'joined-sub3','{"objective":"Third"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as third \gset
select tests.reset_role();
select is((select joined_worker_ids from public.agent_tasks where id=:'job'::uuid),'{}'::uuid[],'a named Worker has not joined before it takes work');

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'first'::uuid,'custom')->>'run_id' as worker_run \gset
select tests.reset_role();
select is((select joined_worker_ids from public.agent_tasks where id=:'job'::uuid),array[(:'f'::jsonb->>'agent')::uuid],'taking a subtask joins the job without join_job');

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'second'::uuid,'custom')->>'run_id' as worker_run2 \gset
select tests.reset_role();
select is((select joined_worker_ids from public.agent_tasks where id=:'job'::uuid),array[(:'f'::jsonb->>'agent')::uuid],'a second subtask does not repeat the Worker');

select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'third'::uuid,'custom')->>'run_id' as lead_sub_run \gset
select tests.reset_role();
select is((select joined_worker_ids from public.agent_tasks where id=:'job'::uuid),array[(:'f'::jsonb->>'agent')::uuid],'an agent the job did not name stays out');
select is((select state from public.agent_tasks where id=:'first'::uuid),'working','the claim itself still succeeds');

select * from finish();
rollback;
