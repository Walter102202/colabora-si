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
select * from finish();
rollback;
