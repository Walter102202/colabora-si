-- Round 3 demo contracts: proposed jobs, notifications, and confirmed messages.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer \gset
select tests.make_agent(:'ws','demo-trama@test.invalid','lead','page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform=true,sponsor_user_id=:'owner',rate_limit_per_min=1000 where id=:'pa';
select tests.make_agent(:'ws','Claude Code','lead','page_A') as lead \gset
select tests.make_agent(:'ws','Codex','worker','page_A') as worker \gset
select tests.make_agent(:'ws','Muse Code','worker','page_A') as worker2 \gset
insert into public.agent_connections(workspace_id,agent_id,page_id,created_by,verified_at)
select :'ws',id,'page_A',:'owner',now() from public.agents where workspace_id=:'ws' and not is_platform;
select tests.make_page(:'ws','demo-board',null,'{"id":"demo-board","title":"Demo jobs","blocks":[],"database":{"properties":[{"id":"title","name":"Name","type":"text"},{"id":"status","type":"agentStatus"}],"rows":[],"views":[]}}');
select jsonb_build_object('board_id','demo-board','title','Team offsite','lead_agent_id',:'lead'::jsonb->>'agent','worker_agent_ids',jsonb_build_array(:'worker'::jsonb->>'agent',:'worker2'::jsonb->>'agent')) as job \gset
select jsonb_build_object('summary','Organize Team offsite. Codex researches; Muse writes pages; Claude reviews progress and gives feedback.','job',:'job'::jsonb) as spec \gset
select tests.make_user('foreign-demo@test.invalid') as foreign_owner \gset
insert into public.workspaces(name,owner_id) values ('Foreign',:'foreign_owner') returning id as foreign_ws \gset
select tests.make_page(:'foreign_ws','foreign-demo-page');
select tests.make_agent(:'foreign_ws','foreign-demo-agent','lead','foreign-demo-page') as foreign_agent \gset
select tests.set_human(:'owner');
select public.post_agent_message(:'ws','Create this job with Claude and workers',gen_random_uuid())->>'message_id' as msg \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner' and state='queued' \gset
select tests.set_agent(:'pu',:'pa');
select public.claim_task(:'req','demo')->>'run_id' as run \gset
select public.assist_request_context(:'req') as context \gset
select (:'context'::jsonb->>'through_seq')::bigint as seq \gset
select is(:'context'::jsonb->>'proposal_message_id',:'msg','a board enables proposals without an open page');
select is(:'context'::jsonb#>>'{boards,0,id}','demo-board','writable job board in context');
select is(jsonb_array_length(:'context'::jsonb->'agents'),4,'only verified external agents offered');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',jsonb_set(:'spec','{job,board_id}','"page_A"'))),'invalid_job','reject plain page');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',jsonb_set(:'spec','{job,lead_agent_id}',to_jsonb(gen_random_uuid()::text)))),'invalid_job','reject unknown agent');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',jsonb_set(:'spec','{job,lead_agent_id}',to_jsonb(:'pa'::text)))),'invalid_job','reject platform');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',jsonb_set(:'spec','{job,lead_agent_id}',to_jsonb(:'worker'::jsonb->>'agent')))),'invalid_job','reject worker as lead');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',jsonb_set(:'spec','{job,worker_agent_ids}',jsonb_build_array(:'worker'::jsonb->>'agent',:'worker'::jsonb->>'agent')))),'invalid_job','reject duplicate workers');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',jsonb_set(:'spec','{job,lead_agent_id}',to_jsonb(:'foreign_agent'::jsonb->>'agent')))),'invalid_job','reject another workspace agent');
select tests.reset_role();
update public.agent_connections set verified_at=null where agent_id=(:'worker'::jsonb->>'agent')::uuid;
select tests.set_agent(:'pu',:'pa');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',:'spec')),'invalid_job','reject unverified worker');
select tests.reset_role();
update public.agent_connections set verified_at=now() where agent_id=(:'worker'::jsonb->>'agent')::uuid;
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values ('demo-board',:'ws',:'owner','demo-board');
select tests.set_agent(:'pu',:'pa');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Offer',:'seq',:'msg',:'spec')),'invalid_job','reject private board even for its owner');
select tests.reset_role();
delete from public.private_pages where page_id='demo-board';
select tests.set_agent(:'pu',:'pa');
select public.reply_person_message(:'run','Review the job',:'seq',null,:'msg',null,:'spec'::jsonb)->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome#>>'{job,lead,name}' from public.agent_messages where id=:'reply'),'Claude Code','saved team uses authoritative names');
update public.agents set status='paused' where id=(:'worker'::jsonb->>'agent')::uuid;
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.start_proposed_work(%L)',:'reply')),'invalid_job','revalidate agent on click');
select tests.reset_role();
select is(jsonb_array_length((select data#>'{database,rows}' from public.pages where id='demo-board')),0,'failed click leaves no row');
update public.agents set status='enabled' where id=(:'worker'::jsonb->>'agent')::uuid;
select tests.set_human(:'owner');
select public.start_proposed_work(:'reply') as started \gset
select is(public.start_proposed_work(:'reply'),:'started'::jsonb||'{"already_started":true}','double click returns the same task');
select tests.reset_role();
select (:'started'::jsonb->>'task_id') as job_task, (:'started'::jsonb->>'page_id') as job_page \gset
select is((select title from public.pages where id=:'job_page'),'Team offsite','new job row title');
select is(jsonb_array_length((select data#>'{database,rows}' from public.pages where id='demo-board')),1,'one row');
select is((select count(*) from public.agent_tasks where row_page_id=:'job_page'),1::bigint,'one task');
select is((select objective from public.task_briefs where task_id=:'job_task'),:'spec'::jsonb->>'summary','exact summary becomes lead brief');
select is((select delegate_agent_id::text from public.agent_tasks where id=:'job_task'),:'lead'::jsonb->>'agent','requested Lead delegated');
select ok((select named_worker_ids @> array[(:'worker'::jsonb->>'agent')::uuid,(:'worker2'::jsonb->>'agent')::uuid] and cardinality(named_worker_ids)=2 from public.agent_tasks where id=:'job_task'),'named workers assigned');
select is((select count(*) from public.agent_grants where page_id='demo-board' and scopes @> array['read','write','comment'] and inherit),3::bigint,'team receives inherited board access');
-- Decline a copy with a distinct incoming proposal key; no second row.
insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,outcome)
select workspace_id,user_id,agent_id,direction,channel,kind,body,outcome||'{"kind":"work_proposed"}' from public.agent_messages where id=:'reply' returning id as declined \gset
select tests.set_human(:'owner');
select is(public.decline_proposed_work(:'declined'),'{"declined":true}'::jsonb,'Not now settles a job');
select tests.reset_role();
-- Active-run feedback and bounded worker progress are notifications, not new runs.
select tests.make_page(:'ws','demo-child',:'job_page');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job_task','demo-lead')->>'run_id' as lead_run \gset
select public.create_subtask(:'job_task','demo-child','{"objective":"Research"}',(:'worker'::jsonb->>'agent')::uuid)->>'task_id' as child \gset
select tests.reset_role();
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.claim_task(:'child','demo-worker')->>'run_id' as child_run \gset
select public.post_activity(:'child_run','response','{"text":"Research started"}');
select public.post_activity(:'child_run','response','{"text":"Research continuing"}');
select tests.reset_role();
select is((select count(*) from public.agent_events where task_id=:'job_task' and type='subtask.progress'),1::bigint,'worker progress throttled per subtask');
select is((select payload->>'worker_name' from public.agent_events where task_id=:'job_task' and type='subtask.progress'),'Codex','progress names the worker');
update public.agent_events set created_at=now()-interval '3 minutes' where task_id=:'job_task' and type='subtask.progress';
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.post_activity(:'child_run','action','{"op":"research","summary":"More research"}');
select tests.reset_role();
select is((select count(*) from public.agent_events where task_id=:'job_task' and type='subtask.progress'),2::bigint,'progress resumes after two minutes');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.send_agent_message(:'child','Check the dates','feedback');
select tests.reset_role();
select is((select count(*) from public.agent_events where task_id=:'child' and type='task.message'),1::bigint,'active external delegate receives message event');
select is((select payload#>>'{from,name}' from public.agent_events where task_id=:'child' and type='task.message'),'Claude Code','event names the sender');
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select is(public.take_pending_messages()#>>'{0,text}','Check the dates','tool notice takes pending feedback');
select is(public.take_pending_messages(),'[]'::jsonb,'tool notice is delivered once');
select is(public.heartbeat(:'child_run')->'pending_prompts','[]'::jsonb,'heartbeat shares the delivery cursor');
select tests.reset_role();
select tests.set_human(:'owner');
select public.send_agent_message(:'child','Use local dates','feedback');
select tests.reset_role();
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select is(public.heartbeat(:'child_run')#>>'{pending_prompts,0,text}','Use local dates','heartbeat takes new feedback');
select is(public.take_pending_messages(),'[]'::jsonb,'already-heartbeated feedback is not repeated');
select tests.reset_role();
update public.agents set is_platform=false where id=:'pa';
update public.agents set is_platform=true where id=(:'worker'::jsonb->>'agent')::uuid;
select tests.set_human(:'owner');
select public.send_agent_message(:'child','Platform message','feedback');
select tests.reset_role();
select is((select count(*) from public.agent_events where task_id=:'child' and type='task.message'),2::bigint,'platform delegate receives no message event');
select is((select count(*) from public.agent_runs where task_id=:'child'),1::bigint,'notifications do not create another run');
update public.agents set is_platform=false where id=(:'worker'::jsonb->>'agent')::uuid;
update public.agents set is_platform=true where id=(:'lead'::jsonb->>'agent')::uuid;
update public.agent_events set created_at=now()-interval '3 minutes' where task_id=:'job_task' and type='subtask.progress';
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.post_activity(:'child_run','response','{"text":"No platform progress event"}');
select tests.reset_role();
select is((select count(*) from public.agent_events where task_id=:'job_task' and type='subtask.progress'),2::bigint,'platform Lead is not notified');
update public.agents set is_platform=false where id=(:'lead'::jsonb->>'agent')::uuid;
update public.agents set is_platform=true where id=:'pa';
-- Confirmed messages use the same explicit-person proposal boundary.
select tests.set_human(:'owner');
select public.post_agent_message(:'ws','Tell Codex to use local dates',gen_random_uuid())->>'message_id' as message_request \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner' and state='queued' \gset
select tests.set_agent(:'pu',:'pa');
select public.claim_task(:'req','message-proposal')->>'run_id' as run \gset
select public.assist_request_context(:'req') as message_context \gset
select (:'message_context'::jsonb->>'through_seq')::bigint as seq \gset
select ok(exists(select 1 from jsonb_array_elements(:'message_context'::jsonb->'active_tasks') t where t->>'task_id'=:'child'),'readable active child offered');
select jsonb_build_object('message',jsonb_build_object('task_id',:'child','text','Use local dates exactly.')) as message_spec \gset
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Review',:'seq',:'message_request',jsonb_set(:'message_spec','{message,text}','""'))),'invalid_message','empty proposed message rejected');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Review',:'seq',:'message_request',jsonb_set(:'message_spec','{message,task_id}',to_jsonb(gen_random_uuid()::text)))),'invalid_message','unknown task rejected');
select tests.reset_role();
update public.agent_tasks set state='done' where id=:'child';
select tests.set_agent(:'pu',:'pa');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Review',:'seq',:'message_request',:'message_spec')),'invalid_message','closed task rejected');
select tests.reset_role();
update public.agent_tasks set state='working' where id=:'child';
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values ('demo-child',:'ws',:'viewer','demo-child');
select tests.set_agent(:'pu',:'pa');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L::jsonb)',:'run','Review',:'seq',:'message_request',:'message_spec')),'invalid_message','unreadable task rejected');
select tests.reset_role();
delete from public.private_pages where page_id='demo-child';
select tests.set_agent(:'pu',:'pa');
select public.reply_person_message(:'run','Review the message',:'seq',null,:'message_request',null,:'message_spec'::jsonb)->>'message_id' as message_proposal \gset
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'message_proposal')),'humans_only','agent cannot send a proposal');
select tests.reset_role();
select tests.set_human(:'viewer');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'message_proposal')),'not_found','another person cannot send');
select tests.set_human(:'owner','chat-client');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'message_proposal')),'direct_session_required','OAuth cannot send');
select tests.reset_role();
update public.agent_tasks set state='done' where id=:'child';
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'message_proposal')),'task_closed','task closed after proposing cannot receive the message');
select tests.reset_role();
update public.agent_tasks set state='working' where id=:'child';
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values ('demo-child',:'ws',:'viewer','demo-child');
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'message_proposal')),'not_found','read access rechecked when sending');
select tests.reset_role();
delete from public.private_pages where page_id='demo-child';
select tests.set_human(:'owner');
select public.send_proposed_message(:'message_proposal') as sent \gset
select is(public.send_proposed_message(:'message_proposal'),:'sent'::jsonb||'{"already_sent":true}','second send is idempotent');
select tests.reset_role();
select is((select count(*) from public.agent_activities where task_id=:'child' and type='prompt' and body->>'text'='Use local dates exactly.'),1::bigint,'exact visible text sent once');
select is((select outcome->>'kind' from public.agent_messages where id=:'message_proposal'),'message_sent','sent state persisted');
insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,outcome)
select workspace_id,user_id,agent_id,direction,channel,kind,body,outcome||'{"kind":"message_proposed"}' from public.agent_messages where id=:'message_proposal' returning id as declined_message \gset
select tests.set_human(:'owner');
select is(public.decline_proposed_work(:'declined_message'),'{"declined":true}'::jsonb,'message can be declined');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'declined_message')),'already_settled','declined message cannot send');
select tests.reset_role();
update public.agent_messages set user_id=:'viewer',outcome=outcome||'{"kind":"message_proposed"}' where id=:'declined_message';
delete from public.workspace_members where workspace_id=:'ws' and user_id=:'viewer';
select tests.set_human(:'viewer');
select is(tests.error_of(format('select public.send_proposed_message(%L)',:'declined_message')),'not_found','former member cannot send');
select tests.reset_role();
select * from finish();
rollback;
