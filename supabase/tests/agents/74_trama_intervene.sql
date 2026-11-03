-- Per-job digest: permission filtering, bounded activity, open context and answer cursor.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer \gset
select tests.make_agent(:'ws','Trama','lead','page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform=true,sponsor_user_id=:'owner',rate_limit_per_min=1000 where id=:'pa';
select tests.make_agent(:'ws','Claude Code','lead','page_A') as lead \gset
select tests.make_agent(:'ws','Codex','worker','page_A') as worker \gset
select tests.make_page(:'ws','digest-job','page_A');
select tests.make_page(:'ws','digest-child-1','digest-job');
select tests.make_page(:'ws','digest-child-2','digest-job');
select tests.make_page(:'ws','secret-child','digest-job');
select tests.make_page(:'ws','other-job','page_A');
select tests.make_page(:'ws','second-job','page_A');
select tests.set_human(:'owner');
select public.create_agent_task('digest-job','{"objective":"Launch"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as job \gset
select public.create_agent_task('digest-child-1','{"objective":"Research"}',(:'worker'::jsonb->>'agent')::uuid,:'job')->>'task_id' as child1 \gset
select public.create_agent_task('digest-child-2','{"objective":"Write"}',(:'worker'::jsonb->>'agent')::uuid,:'job')->>'task_id' as child2 \gset
select public.create_agent_task('secret-child','{"objective":"Secret"}',(:'worker'::jsonb->>'agent')::uuid,:'job')->>'task_id' as secret \gset
select public.create_agent_task('other-job','{"objective":"Other owner"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as other \gset
select public.create_agent_task('second-job','{"objective":"Second job"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as second \gset
select tests.reset_role();
update public.agent_tasks set owner_user_id=:'viewer' where id=:'other';
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values ('secret-child',:'ws',:'viewer','secret-child');
insert into public.agent_activities(workspace_id,task_id,seq,type,body,author_type,author_id,created_at)
select :'ws',:'job',100+n,'response',jsonb_build_object('text','Update '||n),'agent',(:'lead'::jsonb->>'agent')::uuid,now()+make_interval(mins=>n) from generate_series(1,5) n;
insert into public.agent_activities(workspace_id,task_id,seq,type,body,author_type,author_id,created_at) values
(:'ws',:'child1',100,'action',jsonb_build_object('summary',repeat('x',300)),'agent',(:'worker'::jsonb->>'agent')::uuid,now()+interval '10 minutes'),
(:'ws',:'secret',100,'response','{"text":"secret activity"}','agent',(:'worker'::jsonb->>'agent')::uuid,now()),
(:'ws',:'child2',100,'response','{"text":"   "}','agent',(:'worker'::jsonb->>'agent')::uuid,now());
insert into public.agent_activities(workspace_id,task_id,seq,type,body,author_type,author_id,ephemeral) values
(:'ws',:'child2',101,'thought','{"text":"ephemeral activity"}','agent',(:'worker'::jsonb->>'agent')::uuid,true);
update public.agent_tasks set last_activity_at=now()+interval '20 minutes' where id=:'second';
select tests.set_human(:'owner');
select public.post_agent_message(:'ws','How is the launch going?',gen_random_uuid(),'{"page_id":"digest-child-1"}')->>'message_id' as msg \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner' and state='queued' \gset
select tests.set_agent(:'pu',:'pa');
select public.claim_task(:'req','digest')->>'run_id' as run \gset
select public.assist_request_context(:'req') as ctx \gset
select is((select t->>'is_lead' from jsonb_array_elements(:'ctx'::jsonb->'active_tasks') t where t->>'task_id'=:'job'),'true','job task is a Lead target');
select is((select t->>'job_task_id' from jsonb_array_elements(:'ctx'::jsonb->'active_tasks') t where t->>'task_id'=:'job'),:'job','top-level job points to itself');
select is((select t->>'parent_task_id' from jsonb_array_elements(:'ctx'::jsonb->'active_tasks') t where t->>'task_id'=:'child1'),:'job','subtask names its parent');
select is((select t->>'job_task_id' from jsonb_array_elements(:'ctx'::jsonb->'active_tasks') t where t->>'task_id'=:'child1'),:'job','subtask points to its job');
select is((select t->>'is_lead' from jsonb_array_elements(:'ctx'::jsonb->'active_tasks') t where t->>'task_id'=:'child1'),'false','worker task is not a Lead target');
select is(:'ctx'::jsonb#>>'{jobs,0,task_id}',:'job','open subtask puts its job first');
select is(:'ctx'::jsonb#>>'{jobs,0,open}','true','open subtask marks its job open');
select is(:'ctx'::jsonb#>>'{jobs,0,lead,name}','Claude Code','job names its Lead');
select is(jsonb_array_length(:'ctx'::jsonb#>'{jobs,0,subtasks}'),2,'only readable subtasks appear');
select is(jsonb_array_length(:'ctx'::jsonb#>'{jobs,0,recent}'),4,'recent activity bounded to four');
select is(length(:'ctx'::jsonb#>>'{jobs,0,recent,0,text}'),240,'recent text bounded to 240');
select is((select length(s#>>'{last,text}') from jsonb_array_elements(:'ctx'::jsonb#>'{jobs,0,subtasks}') s where s->>'task_id'=:'child1'),160,'subtask last text bounded to 160');
select is(:'ctx'::jsonb#>>'{jobs,0,recent,1,text}','Update 5','recent is newest first');
select is((select s#>>'{last,text}' from jsonb_array_elements(:'ctx'::jsonb#>'{jobs,0,subtasks}') s where s->>'task_id'=:'child2'),'Write','blank and ephemeral activities do not replace the initial prompt');
select ok((:'ctx'::jsonb->'jobs')::text not like '%secret%' and (:'ctx'::jsonb->'jobs')::text not like '%ephemeral activity%','private and ephemeral activity never leaks');
select ok(not exists(select 1 from jsonb_array_elements(:'ctx'::jsonb->'jobs') j where j->>'task_id'=:'other'),'another owner job is excluded');
select is(:'ctx'::jsonb#>>'{jobs,0,url}','/p/digest-job?task='||:'job','job links to the row and task');
select is(:'ctx'::jsonb->'last_answer_at','null'::jsonb,'no previous answer has a null cursor');
select tests.reset_role();
insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,created_at) values
(:'ws',:'owner',:'pa','out','surface','text','Earlier answer',now()-interval '2 minutes'),
(:'ws',:'owner',:'pa','out','surface','text','Latest answer',now()-interval '1 minute') ;
select max(created_at) as answer_at from public.agent_messages where workspace_id=:'ws' and user_id=:'owner' and direction='out' \gset
select tests.set_agent(:'pu',:'pa');
select is(public.assist_request_context(:'req')->>'last_answer_at',to_jsonb(:'answer_at'::timestamptz)#>>'{}','latest answer supplies the cursor');
select tests.reset_role();
insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,outcome)
values (:'ws',:'owner',:'pa','out','surface','system','New conversation','{"kind":"conversation_reset"}');
select tests.set_agent(:'pu',:'pa');
select is(public.assist_request_context(:'req')->'last_answer_at','null'::jsonb,'answers before the current thread do not become the cursor');
select tests.reset_role();
-- A confirmed proposal has human provenance, one durable receipt and a shared prompt cursor.
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.claim_task(:'child1','intervene-worker')->>'run_id' as child_run \gset
select tests.reset_role();
insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,outcome)
values (:'ws',:'owner',:'pa','out','surface','text','Review the message',jsonb_build_object('kind','message_proposed','task_id',:'child1','task_title','Research','agent_name','Codex','text','Add source links.')) returning id as proposal \gset
select tests.set_agent(:'pu',:'pa');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'proposal')),'humans_only','agent cannot confirm a proposal');
select tests.set_human(:'owner','oauth-client');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'proposal')),'direct_session_required','OAuth cannot confirm a proposal');
select tests.set_human(:'owner');
select public.send_proposed_message(:'proposal') as sent \gset
select is(public.send_proposed_message(:'proposal'),:'sent'::jsonb||'{"already_sent":true}','double click returns the same receipt');
select tests.reset_role();
select seq as prompt_seq from public.agent_activities where task_id=:'child1' and type='prompt' and body->>'text'='Add source links.' \gset
select is((select author_type from public.agent_activities where task_id=:'child1' and seq=:'prompt_seq'),'human','confirmed message belongs to the person');
select is((select body->>'source' from public.agent_activities where task_id=:'child1' and seq=:'prompt_seq'),'trama','confirmed message records Trama provenance');
select is((select payload#>>'{from,via}' from public.agent_events where task_id=:'child1' and type='task.message'),'Trama','event carries Trama provenance');
select is((select payload->>'prompt_seq' from public.agent_events where task_id=:'child1' and type='task.message'),:'prompt_seq','event identifies its prompt');
select is((select count(*) from public.agent_activities where task_id=:'child1' and body->>'text'='Add source links.'),1::bigint,'double click creates one prompt');
select is((select count(*) from public.agent_events where task_id=:'child1' and type='task.message'),1::bigint,'double click creates one event');
select ok((select outcome ? 'sent_at' and outcome->>'delivery'='queued_for_run' and outcome->>'prompt_seq'=:'prompt_seq' from public.agent_messages where id=:'proposal'),'sent outcome includes delivery, timestamp and prompt sequence');
update public.agents set capabilities=capabilities||'{"continue":true}' where id=(:'lead'::jsonb->>'agent')::uuid;
insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,outcome)
values (:'ws',:'owner',:'pa','out','surface','text','Review',jsonb_build_object('kind','message_proposed','task_id',:'second','text','Add a checklist.')) returning id as dispatched_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'dispatched_proposal');
select tests.reset_role();
select is((select payload#>>'{from,type}' from public.agent_events where task_id=:'second' and type='task.feedback'),'human','dispatched feedback identifies its human author');
select is((select payload#>>'{from,via}' from public.agent_events where task_id=:'second' and type='task.feedback'),'Trama','dispatched feedback preserves Trama provenance');
select is((select count(*) from private.sent_person_messages where message_id=:'proposal' and task_id=:'child1' and prompt_seq=:'prompt_seq'),1::bigint,'double click creates one private receipt');
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select is(public.take_pending_messages()#>>'{0,via}','Trama','taking prompts preserves Trama provenance');
select tests.set_human(:'owner');
select public.send_agent_message(:'child1','Direct panel message');
select tests.reset_role();
select is((select body->>'source' from public.agent_activities where task_id=:'child1' and body->>'text'='Direct panel message'),'row_panel','direct callers cannot impersonate Trama provenance');
select ok(not has_function_privilege('authenticated','private.send_agent_message_core(uuid,text,text,text[],text,text)','EXECUTE'),'private send core is inaccessible to clients');
select * from finish();
rollback;