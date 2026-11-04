-- Meeting quotas and summary authority, including independent voice budgets.
begin;
select plan(27);
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner,
       (:'f'::jsonb->>'viewer') as viewer, (:'f'::jsonb->>'agent') as agent,
       (:'f'::jsonb->>'agent_user') as agent_user \gset
select tests.make_agent(:'ws'::uuid, 'meeting-platform@agents.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform = true, sponsor_user_id = :'owner'::uuid where id = :'pa'::uuid;
insert into public.workspaces(name,owner_id) values ('Other meeting workspace', :'owner') returning id as other_ws \gset
select tests.set_human(:'owner'::uuid);
select lives_ok(format($q$select public.voice_reserve(%L,60000,1920044,'meeting','meeting-block')$q$, :'ws'), 'person reserves a meeting segment');
select ok((select id from public.voice_clips where channel = 'meeting' limit 1) is not null, 'reservation has a clip id');
select is((select meeting_block_id from public.voice_clips where channel = 'meeting' limit 1), 'meeting-block', 'clips retain the meeting block id');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L,151000,4832044,'meeting','meeting-block')$q$, :'ws')), 'PT422', 'meeting segment stops at 150 seconds');
select is(tests.sqlstate_of($q$select public.voice_reserve(null,60000,1920044,'meeting','meeting-block')$q$), 'PT403', 'workspace required');
select tests.reset_role();
insert into public.agent_oauth_links(user_id,client_id,as_human) values (:'owner','meeting-client',true);
select tests.set_human(:'owner'::uuid,'meeting-client');
select is(tests.error_of(format($q$select public.voice_reserve(%L,1000,32044,'meeting','meeting-block')$q$, :'ws')), 'direct_session_required', 'OAuth human impersonation cannot reserve audio');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.error_of(format($q$select public.voice_reserve(%L,60000,1920044,'meeting','meeting-block')$q$, :'ws')), 'humans_only', 'even platform agents cannot reserve meeting audio');
select tests.reset_role();
insert into public.voice_clips(workspace_id,user_id,agent_id,channel,status,duration_ms,bytes,model)
select :'ws', :'owner', :'pa', 'meeting','transcribed',1000,32044,'muse-voice-transcribe-1.0' from generate_series(1,239);
select tests.set_human(:'owner'::uuid);
select is(tests.error_of(format($q$select public.voice_reserve(%L,1000,32044,'meeting','meeting-block')$q$, :'ws')), 'voice_quota', '241st segment is rejected');
select lives_ok(format($q$select public.voice_reserve(%L,1000,48044)$q$, :'ws'), 'meeting count does not consume surface quota');
select tests.reset_role();
delete from public.voice_clips where channel = 'meeting';
insert into public.voice_clips(workspace_id,user_id,agent_id,channel,status,duration_ms,bytes,model,created_at)
values (:'ws', :'owner', :'pa','meeting','transcribed',14400000,32044,'muse-voice-transcribe-1.0',now()-interval '2 hours');
select tests.set_human(:'owner'::uuid);
select is(tests.error_of(format($q$select public.voice_reserve(%L,1000,32044,'meeting','meeting-block')$q$, :'ws')), 'voice_quota', 'four hour person quota');
select tests.reset_role();
update public.voice_clips set workspace_id = :'other_ws' where channel='meeting';
select tests.set_human(:'owner'::uuid);
select is(tests.error_of(format($q$select public.voice_reserve(%L,1000,32044,'meeting','meeting-block')$q$, :'ws')), 'voice_quota', 'person cannot reset the allowance by changing workspace');
select tests.reset_role();
update public.voice_clips set duration_ms=72000000 where channel='meeting';
select tests.set_human(:'viewer'::uuid);
select is(tests.error_of(format($q$select public.voice_reserve(%L,1000,32044,'meeting','meeting-block')$q$, :'ws')), 'voice_quota', 'twenty hour global quota');
select is(tests.error_of($q$select public.request_meeting_summary('page_B','meeting-block')$q$), 'forbidden', 'viewer cannot request a summary');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select public.request_meeting_summary('page_B','meeting-block','es')->>'task_id' as req \gset
select is((select request_kind from public.agent_tasks where id=:'req'), 'meeting', 'meeting request kind');
select is((select row_page_id from public.agent_tasks where id=:'req'), 'page_B', 'request is bound to its page');
select is((select request from public.agent_tasks where id=:'req'), '{"page_id":"page_B","block_id":"meeting-block","lang":"es"}'::jsonb, 'request retains meeting and language');
select is(tests.error_of($q$select public.request_meeting_summary('page_B','meeting-block')$q$), 'request_in_progress', 'only one open request per page');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.error_of($q$select public.request_meeting_summary('page_B','meeting-block')$q$), 'humans_only', 'agent cannot request a meeting summary');
select public.claim_task(:'req'::uuid,'custom')->>'run_id' as run \gset
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$select public.complete_meeting_summary(%L,'{}','finish')$q$, :'run')), 'PT403', 'person cannot complete agent run');
select tests.reset_role();
select tests.set_agent(:'agent_user'::uuid, :'agent'::uuid);
select is(tests.sqlstate_of(format($q$select public.complete_meeting_summary(%L,'{}','finish')$q$, :'run')), 'PT403', 'another agent cannot complete the run');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.complete_meeting_summary(:'run','{"input_tokens":100,"output_tokens":40,"cost_usd":0.01}','finish') as result \gset
select is((select state from public.agent_tasks where id=:'req'), 'done', 'summary closes task');
select is((select acceptance from public.agent_tasks where id=:'req'), 'accepted', 'summary is accepted');
select is((select status from public.agent_runs where id=:'run'), 'completed', 'run completes');
select is((select cost_usd from public.agent_runs where id=:'run'), 0.01::numeric, 'usage is recorded');
select is(public.complete_meeting_summary(:'run','{"cost_usd":1}','finish'), :'result'::jsonb, 'receipt retry is idempotent');
select is((select cost_usd from public.agent_runs where id=:'run'), 0.01::numeric, 'receipt retry never bills again');
select tests.reset_role();
select tests.set_agent(:'agent_user'::uuid, :'agent'::uuid);
select is(tests.sqlstate_of(format($q$select public.complete_meeting_summary(%L,'{}','finish')$q$, :'run')), 'PT403', 'another agent cannot replay the receipt');
select tests.reset_role();
select * from finish();
rollback;
