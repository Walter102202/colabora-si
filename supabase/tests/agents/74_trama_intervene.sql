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
select ok(not has_function_privilege('authenticated','private.send_agent_message_core(uuid,text,text,text[],text,text,text)','EXECUTE'),'private send core is inaccessible to clients');
-- Receipt transitions exercise each existing delivery route without extra model turns.
create function tests.intervene_proposal(p_template uuid, p_task uuid, p_text text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.agent_messages(workspace_id,user_id,agent_id,direction,channel,kind,body,outcome)
    select workspace_id,user_id,agent_id,'out','surface','text','Review',
      jsonb_build_object('kind','message_proposed','task_id',p_task,'text',p_text)
    from public.agent_messages where id=p_template returning id into v_id;
  return v_id;
end $$;
select ok((select outcome ? 'received_at' from public.agent_messages where id=:'proposal'),'passive tool notices mark receipt');
select tests.intervene_proposal(:'proposal',:'child1','Heartbeat delivery') as heartbeat_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'heartbeat_proposal');
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.heartbeat(:'child_run');
select tests.reset_role();
select ok((select outcome ? 'received_at' from public.agent_messages where id=:'heartbeat_proposal'),'heartbeat cursor marks receipt');
select tests.intervene_proposal(:'proposal',:'child1','Bridge delivery') as bridge_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'bridge_proposal');
select tests.reset_role();
select event_id as bridge_event from public.agent_events where task_id=:'child1' and payload->>'text'='Bridge delivery' \gset
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.mark_events_delivered(array[:'bridge_event'::uuid]);
select tests.reset_role();
select ok((select outcome ? 'received_at' from public.agent_messages where id=:'bridge_proposal'),'bridge event delivery marks receipt');
update public.agents set capabilities=capabilities||'{"continue":false}' where id=(:'lead'::jsonb->>'agent')::uuid;
select tests.intervene_proposal(:'proposal',:'job','Next session delivery') as queued_proposal \gset
select tests.set_human(:'owner');
select is(public.send_proposed_message(:'queued_proposal')->>'delivery','queued_for_next_session','closed session waits for next run');
select tests.reset_role();
select ok(not (select outcome ? 'received_at' from public.agent_messages where id=:'queued_proposal'),'queued message is not prematurely received');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'job','intervene-lead')->>'run_id' as lead_run \gset
select tests.reset_role();
select ok((select outcome ? 'received_at' from public.agent_messages where id=:'queued_proposal'),'next run marks queued message received');
select tests.intervene_proposal(:'proposal',:'child1','Acknowledge this') as reply_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'reply_proposal');
select tests.reset_role();
insert into public.agent_activities(workspace_id,task_id,seq,type,body,author_type,author_id) values
(:'ws',:'child1',2,'response','{"text":"Older sequence"}','agent',(:'worker'::jsonb->>'agent')::uuid),
(:'ws',:'child1',private.next_seq(:'child1'),'response','{"text":"Wrong author"}','agent',(:'lead'::jsonb->>'agent')::uuid);
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.post_activity(:'child_run','response','{"text":"Transient"}',true);
select public.post_activity(:'child_run','response','{"text":"   "}');
select tests.reset_role();
select ok(not (select outcome ? 'reply' from public.agent_messages where id=:'reply_proposal'),'old sequence, other author, ephemeral and blank activities do not acknowledge');
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.post_activity(:'child_run','thought',jsonb_build_object('text',repeat('Acknowledged ',40)));
select tests.reset_role();
select ok((select outcome ? 'received_at' and outcome ? 'reply' from public.agent_messages where id=:'reply_proposal'),'first saved thought supplies receipt and reply');
select is((select length(outcome#>>'{reply,text}') from public.agent_messages where id=:'reply_proposal'),300,'reply is bounded to 300 characters');
select is((select outcome#>>'{reply,agent_name}' from public.agent_messages where id=:'reply_proposal'),'Codex','reply names the responding agent');
select (select coalesce(outcome->'reply','null'::jsonb) from public.agent_messages where id=:'reply_proposal') as first_reply \gset
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select public.post_activity(:'child_run','response','{"text":"Later response"}');
select tests.reset_role();
select is((select outcome->'reply' from public.agent_messages where id=:'reply_proposal'),:'first_reply'::jsonb,'later responses preserve the first reply');
-- Deliberately fail the chat update: the activity must survive and the receipt must roll back.
select tests.intervene_proposal(:'proposal',:'child1','Fail-open delivery') as fail_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'fail_proposal');
select tests.reset_role();
create function tests.reject_intervene_receipt() returns trigger language plpgsql as $$ begin raise exception 'forced receipt update failure'; end $$;
create trigger reject_intervene_receipt before update on public.agent_messages
for each row when (new.id=:'fail_proposal'::uuid) execute function tests.reject_intervene_receipt();
select tests.set_agent((:'worker'::jsonb->>'user')::uuid,(:'worker'::jsonb->>'agent')::uuid);
select lives_ok(format('select public.post_activity(%L,''response'',''{"text":"Survives receipt failure"}'')',:'child_run'),'receipt failure never aborts post_activity');
select tests.reset_role();
select ok(exists(select 1 from public.agent_activities where task_id=:'child1' and body->>'text'='Survives receipt failure'),'activity persisted despite receipt failure');
select is((select reply_activity_id from private.sent_person_messages where message_id=:'fail_proposal'),null::uuid,'failed chat update rolls back the receipt update too');
drop trigger reject_intervene_receipt on public.agent_messages;
drop function tests.reject_intervene_receipt();
-- A platform Lead has no task.message event, but its heartbeat takes the same prompts.
update public.agents set is_platform=false where id=:'pa';
update public.agents set is_platform=true where id=(:'lead'::jsonb->>'agent')::uuid;
select tests.intervene_proposal(:'proposal',:'job','Platform delivery') as platform_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'platform_proposal');
select tests.reset_role();
select is((select count(*) from public.agent_events where task_id=:'job' and type='task.message' and payload->>'text'='Platform delivery'),0::bigint,'platform Lead has no session event');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select ok(public.heartbeat(:'lead_run')->'pending_prompts' @> '[{"text":"Platform delivery","via":"Trama"}]','platform heartbeat receives the prompt');
select tests.reset_role();
select ok((select outcome ? 'received_at' from public.agent_messages where id=:'platform_proposal'),'platform heartbeat marks receipt');
-- Add-and-send keeps the saved brief and its editable row in one transaction.
update public.agents set is_platform=false where id=(:'lead'::jsonb->>'agent')::uuid;
update public.agents set is_platform=true where id=:'pa';
select tests.set_human(:'owner');
select public.update_brief(:'job','{"done_when":[{"id":"c2","text":"Existing criterion","check":"human"}],"constraints":"Keep constraints"}');
select tests.reset_role();
select tests.intervene_proposal(:'proposal',:'job','Add <Y> & sources.') as requirement_proposal \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'requirement_proposal',true) as requirement_sent \gset
select is(:'requirement_sent'::jsonb->>'requirement_id','c3','criterion IDs skip an existing length-plus-one ID');
select is(public.send_proposed_message(:'requirement_proposal',true),:'requirement_sent'::jsonb||'{"already_sent":true}','Add and send is idempotent');
select tests.reset_role();
select is((select brief_version from public.agent_tasks where id=:'job'),3,'adding a criterion increments the brief once');
select is((select done_when->1 from public.task_briefs where task_id=:'job' and version=3),'{"id":"c3","text":"Add <Y> & sources.","check":"human"}'::jsonb,'exact person text becomes a human criterion');
select ok((select constraints='Keep constraints' and author_type='human' and author_id=:'owner' from public.task_briefs where task_id=:'job' and version=3),'brief preserves other fields and human authorship');
select is((select data#>>'{blocks,0,key}' from public.pages where id='digest-job'),'brief:done_when','missing Done when section is created');
select is((select data#>>'{blocks,1,html}' from public.pages where id='digest-job'),'Existing criterion','missing section materializes existing criteria too');
select ok((select data#>>'{blocks,2,type}'='todo' and data#>>'{blocks,2,html}'='Add &lt;Y&gt; &amp; sources.' and data#>>'{blocks,2,attr,by}'='human' and data#>>'{blocks,2,attr,id}'=:'owner' from public.pages where id='digest-job'),'new todo safely renders exact text with person attribution');
select is((select body->>'requirement_id' from public.agent_activities where task_id=:'job' and body->>'text'='Add <Y> & sources.'),'c3','prompt carries criterion ID');
select is((select payload->>'requirement_id' from public.agent_events where task_id=:'job' and type='task.message' and payload->>'text'='Add <Y> & sources.'),'c3','message event carries criterion ID');
select ok(exists(select 1 from public.agent_events where task_id=:'job' and type='brief.updated' and payload->>'brief_version'='3'),'brief update event is emitted');
select data#>>'{blocks,2,id}' as last_criterion from public.pages where id='digest-job' \gset
select tests.set_human(:'owner');
select public.apply_page_ops('digest-job',jsonb_build_array(jsonb_build_object('op','insert_block','after',:'last_criterion','block','{"id":"later-section","type":"heading2","html":"Constraints","key":"brief:constraints"}'::jsonb)));
select tests.reset_role();
select tests.intervene_proposal(:'proposal',:'job','Include examples.') as second_requirement \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'second_requirement',true);
select tests.reset_role();
select ok((select data#>>'{blocks,3,html}'='Include examples.' and data#>>'{blocks,4,id}'='later-section' from public.pages where id='digest-job'),'existing section receives new todo before the next brief section');
select data#>>'{blocks,1,id}' as existing_criterion from public.pages where id='digest-job' \gset
select tests.intervene_proposal(:'proposal',:'job','Conflicting requirement') as conflict_proposal \gset
select tests.set_human(:'owner');
select public.apply_page_ops('digest-job',jsonb_build_array(jsonb_build_object('op','update_block','id',:'existing_criterion','patch','{"html":"Unsaved draft"}'::jsonb)));
select is(tests.error_of(format('select public.send_proposed_message(%L,true)',:'conflict_proposal')),'brief_out_of_sync','unsaved criteria conflict blocks Add and send');
select tests.reset_role();
select ok((select brief_version=4 from public.agent_tasks where id=:'job') and (select data#>>'{blocks,1,html}'='Unsaved draft' from public.pages where id='digest-job') and not exists(select 1 from private.sent_person_messages where message_id=:'conflict_proposal'),'conflict preserves saved brief, draft and unsent proposal');
select tests.set_human(:'owner');
select public.apply_page_ops('digest-job',jsonb_build_array(jsonb_build_object('op','update_block','id',:'existing_criterion','patch','{"html":"Existing criterion"}'::jsonb)));
select tests.reset_role();
select tests.intervene_proposal(:'proposal',:'job','Atomic requirement') as atomic_proposal \gset
create function tests.reject_intervene_page() returns trigger language plpgsql as $$ begin raise exception 'forced page failure'; end $$;
create trigger reject_intervene_page before update on public.pages for each row when (new.id='digest-job') execute function tests.reject_intervene_page();
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.send_proposed_message(%L,true)',:'atomic_proposal')),'forced page failure','page write failure is reported');
select tests.reset_role();
select ok((select brief_version=4 from public.agent_tasks where id=:'job') and not exists(select 1 from public.task_briefs where task_id=:'job' and version>4) and not exists(select 1 from public.agent_activities where task_id=:'job' and body->>'text'='Atomic requirement') and not exists(select 1 from private.sent_person_messages where message_id=:'atomic_proposal'),'page failure rolls back brief, prompt and receipt');
drop trigger reject_intervene_page on public.pages;
drop function tests.reject_intervene_page();
select tests.intervene_proposal(:'proposal',:'job','Unauthorized criterion') as forbidden_proposal \gset
update public.agent_messages set user_id=:'viewer' where id=:'forbidden_proposal';
select tests.set_human(:'viewer');
select is(tests.error_of(format('select public.send_proposed_message(%L,true)',:'forbidden_proposal')),'forbidden','read-only person cannot add a criterion');
select tests.reset_role();
select tests.intervene_proposal(:'proposal',:'job','Send only') as send_only \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'send_only',false);
select tests.reset_role();
select ok((select brief_version=4 from public.agent_tasks where id=:'job') and not (select outcome ? 'requirement_id' from public.agent_messages where id=:'send_only'),'Send only does not change the brief');
select tests.intervene_proposal(:'proposal',:'job','Default send') as default_send \gset
select tests.set_human(:'owner');
select public.send_proposed_message(:'default_send');
select tests.reset_role();
select is((select brief_version from public.agent_tasks where id=:'job'),4,'omitted parameter retains send-only behavior');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select ok(public.heartbeat(:'lead_run')->'pending_prompts' @> '[{"requirement_id":"c3","text":"Add <Y> & sources."}]','pending prompts carry the criterion notice');
select tests.set_human(:'owner');
select public.post_agent_message(:'ws','Ask the Lead to include a checklist',gen_random_uuid())->>'message_id' as requirement_request \gset
select tests.set_agent(:'pu',:'pa');
select public.assist_request_context(:'req')->>'through_seq' as requirement_through \gset
select jsonb_build_object('message',jsonb_build_object('task_id',:'job','text','Include a checklist','adds_requirement',true)) as requirement_spec \gset
select is(tests.error_of(format('select public.reply_person_message(%L,''Review'',%s,null,%L,null,%L::jsonb)',:'run',:'requirement_through',:'requirement_request',jsonb_set(:'requirement_spec','{message,adds_requirement}','"yes"'))),'invalid_message','adds_requirement must be a boolean');
select public.reply_person_message(:'run','Review',:'requirement_through',null,:'requirement_request',null,:'requirement_spec'::jsonb)->>'message_id' as flagged_proposal \gset
select tests.reset_role();
select is((select outcome->'adds_requirement' from public.agent_messages where id=:'flagged_proposal'),'true'::jsonb,'proposal persists the boolean requirement flag');
select * from finish();
rollback;