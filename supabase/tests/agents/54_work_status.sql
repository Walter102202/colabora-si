-- Work summaries use the person's ownership and current page access.
begin;
select plan(8);
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws,(:'f'::jsonb->>'owner') as owner,(:'f'::jsonb->>'viewer') as viewer,(:'f'::jsonb->>'agent') as agent,(:'f'::jsonb->>'agent_user') as au \gset
insert into public.agent_tasks(workspace_id,context_id,row_page_id,title,owner_user_id,created_by,state,delegate_agent_id)
values (:'ws',gen_random_uuid(),'page_A','Own work',:'owner',:'owner','working',:'agent'),
(:'ws',gen_random_uuid(),'page_A1','Other person',:'viewer',:'viewer','queued',:'agent'),
(:'ws',gen_random_uuid(),'page_B','Private other page',:'owner',:'owner','queued',:'agent');
insert into public.private_pages values ('page_B',:'ws',:'viewer','page_B',now());
select tests.set_human(:'owner');
select is(jsonb_array_length(public.person_work_status(:'ws')->'running_work'),1,'only own readable work');
select is(public.person_work_status(:'ws')#>>'{running_work,0,title}','Own work','title comes from the saved row');
select is(public.person_work_status(:'ws')#>>'{running_work,0,agent}','Fixture Agent','agent comes from the saved row');
select is(public.person_work_status(:'ws')#>>'{running_work,0,subtasks_total}','0','no invented subtask progress');
select tests.set_human(:'owner','chat-client');
select is(tests.sqlstate_of(format('select public.person_work_status(%L)',:'ws')),'PT403','OAuth cannot read the direct-person status');
select tests.reset_role();
select tests.set_agent(:'au',:'agent');
select is(tests.sqlstate_of(format('select public.person_work_status(%L)',:'ws')),'PT403','ordinary agents cannot impersonate a person');
select tests.reset_role();
update public.agents set is_platform=true where id=:'agent';
select tests.set_human(:'owner');
select public.post_agent_message(:'ws','How is everything going?',gen_random_uuid());
select tests.reset_role();
select id as request from public.agent_tasks where workspace_id=:'ws' and request_kind='assist' \gset
select tests.set_agent(:'au',:'agent');
select public.claim_task(:'request','test');
select is(public.assist_request_context(:'request')#>>'{running_work,0,title}','Own work','assist includes the same scoped work');
select ok(public.assist_request_context(:'request') ? 'messages','P12 conversation contract remains');
select * from finish();
rollback;
