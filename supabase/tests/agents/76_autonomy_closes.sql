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
select * from finish();
rollback;
