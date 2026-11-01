begin;
select plan(22);
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer,
       (:'f'::jsonb->>'agent') as agent, (:'f'::jsonb->>'agent_user') as agent_user \gset
select tests.make_agent(:'ws'::uuid, 'agent+reset@agents.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform = true, sponsor_user_id = :'owner', rate_limit_per_min = 1000 where id = :'pa';
insert into public.agent_oauth_links (user_id, client_id, as_human) values (:'owner', 'chat-client', true);
select tests.set_agent(:'agent_user', :'agent');
select throws_ok(format('select public.start_new_conversation(%L)', :'ws'), 'PT403', 'humans_only', 'agents cannot reset');
select tests.reset_role();
select tests.set_human(:'owner', 'chat-client');
select throws_ok(format('select public.start_new_conversation(%L)', :'ws'), 'PT403', 'direct_session_required', 'chat cannot reset');
select tests.reset_role();
select tests.make_user('reset-stranger@test.local') as stranger \gset
select tests.set_human(:'stranger');
select throws_ok(format('select public.start_new_conversation(%L)', :'ws'), 'PT403', 'forbidden', 'strangers cannot reset');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.start_new_conversation(%L)', :'ws')), '42501', 'anon cannot reset');
select tests.reset_role();
select tests.set_human(:'owner');
select public.post_agent_message(:'ws', 'Old topic', gen_random_uuid());
select tests.reset_role();
select ok(exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted
  and classid::bigint = ((hashtextextended('conversation:' || :'ws' || ':' || :'owner', 0) >> 32) & 4294967295)
  and objid::bigint = (hashtextextended('conversation:' || :'ws' || ':' || :'owner', 0) & 4294967295)),
  'an uncommitted send holds the conversation lock against concurrent resets');
select id as req from public.agent_tasks where owner_user_id = :'owner' and request_kind = 'assist' \gset
select tests.set_agent(:'pu', :'pa');
select public.claim_task(:'req', 'platform')->>'run_id' as run \gset
select tests.reset_role();
update public.agent_messages set needs_reply = false where user_id = :'owner';
insert into public.agent_messages (workspace_id, user_id, direction, channel, body) values (:'ws', :'viewer', 'in', 'surface', 'Other person');
select count(*) as before_count from public.agent_messages where user_id = :'owner' \gset
select tests.set_human(:'owner');
select is(public.start_new_conversation(:'ws')->>'reset', 'true', 'reset succeeds');
select is(public.start_new_conversation(:'ws')->>'reset', 'false', 'repeat makes no cut');
select tests.reset_role();
select is((select count(*) from public.agent_messages where user_id = :'owner'), :'before_count'::bigint + 1, 'exactly one row added');
select is(private.thread_start(:'ws', :'viewer'), 0::bigint, 'other person has no cut');
select tests.set_agent(:'pu', :'pa');
select is(jsonb_array_length(public.assist_request_context(:'req')->'messages'), 0, 'old messages and cut excluded');
select tests.reset_role();
select tests.set_human(:'owner');
select public.post_agent_message(:'ws', 'save that in notes', gen_random_uuid())->>'message_id' as save_id \gset
select tests.reset_role();
select is((select intent#>>'{resolved,problem}' from public.agent_messages where id = :'save_id'), 'no_target', 'save cannot cross cut');
select tests.set_human(:'owner');
select public.post_agent_message(:'ws', 'New topic', gen_random_uuid())->>'message_id' as pending \gset
select public.post_agent_message(:'ws', 'save that in notes', gen_random_uuid())->>'message_id' as same_save \gset
select tests.reset_role();
select is((select intent#>>'{resolved,text}' from public.agent_messages where id = :'same_save'), 'New topic', 'save works within conversation');
select tests.set_agent(:'pu', :'pa');
select ok(exists(select 1 from jsonb_array_elements(public.assist_request_context(:'req')->'messages') m where m->>'text' = 'New topic'), 'new message reaches model');
select tests.reset_role();
select min(seq) as pending_seq from public.agent_messages where user_id = :'owner' and needs_reply \gset
select tests.set_human(:'owner');
select is(public.start_new_conversation(:'ws')->>'reset', 'true', 'reset preserves pending');
select is(public.start_new_conversation(:'ws')->>'reset', 'false', 'repeat with pending makes no cut');
select tests.reset_role();
select is((select (outcome->>'from_seq')::bigint from public.agent_messages where user_id = :'owner' and outcome->>'kind' = 'conversation_reset' order by seq desc limit 1), :'pending_seq'::bigint, 'oldest pending frozen');
select tests.set_agent(:'pu', :'pa');
select ok(exists(select 1 from jsonb_array_elements(public.assist_request_context(:'req')->'messages') m where m->>'id' = :'pending'), 'pending reaches model');
select is((select count(*) from jsonb_array_elements(public.assist_request_context(:'req')->'messages') m where m->>'text' = 'New conversation'), 0::bigint, 'cut never reaches model');
select public.reply_person_message(:'run', 'Answer', (public.assist_request_context(:'req')->>'through_seq')::bigint);
select tests.reset_role();
select is(private.thread_start(:'ws', :'owner'), :'pending_seq'::bigint, 'answered pending does not move start');
select is((select body from public.agent_messages where id = :'pending'), 'New topic', 'pending retained');
select is((select count(*) from public.agent_messages where user_id = :'viewer' and body = 'Other person'), 1::bigint, 'other person unchanged');
select ok(not has_function_privilege('authenticated', 'private.thread_start(uuid,uuid)', 'execute'), 'thread lookup stays private');
select * from finish();
rollback;
