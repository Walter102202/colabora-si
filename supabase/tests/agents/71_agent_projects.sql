begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'proj-lead@agents.invalid','lead','page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'proj-other@agents.invalid','worker','page_A') as other \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'proj-revoked@agents.invalid','worker','page_A') as revoked \gset
update public.agents set revoked_at=now() where id=(:'revoked'::jsonb->>'agent')::uuid;
update public.agents set is_platform=true, connection='{"harness":"trama"}' where id=(:'lead'::jsonb->>'agent')::uuid;
select tests.make_user('foreign-owner@test.local') as foreign_owner \gset
insert into public.workspaces(name,owner_id) values ('Foreign',:'foreign_owner') returning id as foreign_ws \gset
select tests.make_page(:'foreign_ws','foreign-page');
select tests.make_agent(:'foreign_ws','foreign@agents.invalid','worker','foreign-page');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.list_agents() as roster \gset
select is(jsonb_array_length(:'roster'::jsonb),3,'only enabled unrevoked workspace agents');
select ok((select bool_and(a ?& array['id','name','role','kind','harness','is_platform','me']) from jsonb_array_elements(:'roster') a),'roster exposes delegation fields');
select is((select count(*)::int from jsonb_array_elements(:'roster') a where (a->>'me')::boolean),1,'one self entry');
select is((select a->>'id' from jsonb_array_elements(:'roster') a where (a->>'me')::boolean),:'f'::jsonb->>'agent','self is caller');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of('select public.list_agents()'),'agents_only','human cannot use roster RPC');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of('select public.list_agents()'),'42501','anon cannot use roster RPC');
select tests.reset_role();
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'proj-page','page_A','{"id":"proj-page","title":"Beta launch","blocks":[]}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'proj-piece','proj-page');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('proj-page','{"objective":"Beta launch"}',(:'lead'::jsonb->>'agent')::uuid) as task \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task((:'task'::jsonb->>'task_id')::uuid,'custom');
select public.create_subtask((:'task'::jsonb->>'task_id')::uuid,'proj-piece','{"objective":"Write the launch post"}',(:'f'::jsonb->>'agent')::uuid);
select is(public.join_job('Beta launch','lead')->>'status','joined','platform Lead can join own project');
select is(public.join_job('Beta launch','worker')->>'status','joined','the Lead asked to continue its own project joins as worker too');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.join_job(' beta LAUNCH ','worker') as joined \gset
select is(:'joined'::jsonb->>'status','joined','delegated worker joins project');
select is(:'joined'::jsonb->>'kind','project','project is identified');
select is(:'joined'::jsonb->>'job_id',:'task'::jsonb->>'task_id','existing root task identified');
select is(jsonb_array_length(:'joined'::jsonb->'subtasks'),1,'delegated subtask returned');
select is(:'joined'::jsonb->>'lead_name','proj-lead@agents.invalid','platform Lead named');
select is(:'joined'::jsonb->'pending_rows','[]'::jsonb,'project has no job rows');
select is(jsonb_array_length(:'joined'::jsonb->'workers'),1,'delegated workers included');
select is(public.join_job('Beta launch','lead')->>'status','other_lead','chat cannot change Lead');
select is(public.join_job('No such project','worker')->>'status','not_found','missing project stays missing');
select tests.reset_role();
select tests.set_agent((:'other'::jsonb->>'user')::uuid,(:'other'::jsonb->>'agent')::uuid);
select is(public.join_job('Beta launch','worker')->>'status','not_assigned','reader without assignment cannot join project');
select tests.reset_role();
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'proj-jobs',null,'{"id":"proj-jobs","title":"Jobs","database":{"properties":[{"id":"status","type":"agentStatus"}],"rows":[{"id":"j","pageId":"proj-job"}]}}');
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'proj-job','proj-jobs','{"id":"proj-job","title":"Ordinary job","blocks":[]}');
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'job-lead@agents.invalid','lead','page_A') as joblead \gset
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.assign_job('proj-job',(:'joblead'::jsonb->>'agent')::uuid,array[(:'f'::jsonb->>'agent')::uuid]);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(public.join_job('Ordinary job','worker')->>'kind','job','existing jobs retain their kind');
select tests.reset_role();
-- A project still needs page access, even when its task is delegated.
select tests.reset_role();
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id)
values ('proj-page',(:'f'::jsonb->>'ws')::uuid,(:'f'::jsonb->>'owner')::uuid,'proj-page');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(public.join_job('Beta launch','worker')->>'status','not_found','private projects stay hidden from delegates');
select tests.reset_role();
select * from finish();
rollback;
