-- Trama context follows the person's access, and a proposal never creates a task.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer \gset
select tests.make_agent(:'ws'::uuid, 'trama@test.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform = true, sponsor_user_id = :'owner'::uuid, rate_limit_per_min = 1000 where id = :'pa'::uuid;
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'Summarize this page', gen_random_uuid(), '{"page_id":"page_B","selection":{"page_id":"page_B","text":"selected words"}}')->>'message_id' as msg \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind = 'assist' and owner_user_id = :'owner'::uuid and state = 'queued' \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid, 'trama-check')->>'run_id' as run \gset
select is(public.assist_request_context(:'req'::uuid)#>>'{page,id}', 'page_B', 'person-authorized page is supplied');
select is(public.assist_request_context(:'req'::uuid)->>'selection', 'selected words', 'selection is supplied as data');
select is(public.assist_request_context(:'req'::uuid)->>'proposal_message_id', :'msg', 'proposal is tied to the person message');
select tests.reset_role();
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values ('page_B',:'ws'::uuid,:'viewer'::uuid,'page_B');
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select ok(public.assist_request_context(:'req'::uuid)->'page' = 'null'::jsonb, 'agent grants never reveal another person private page');
select ok(public.assist_request_context(:'req'::uuid)->'selection' = 'null'::jsonb, 'selection from an inaccessible page is withheld');
select tests.reset_role();
update public.private_pages set owner_user_id=:'owner'::uuid where page_id='page_B';
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.reply_person_message(:'run'::uuid,'Summary', (public.assist_request_context(:'req'::uuid)->>'through_seq')::bigint, null);
select tests.reset_role();

-- legitimate
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'Please prepare the page', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select public.post_agent_message(:'ws'::uuid, 'Another message', gen_random_uuid())->>'message_id' as other \gset
select tests.reset_role();

select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner'::uuid and state='queued' \gset
select count(*) as task_count from public.agent_tasks where workspace_id=:'ws'::uuid \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid,'proposal-check')->>'run_id' as run \gset
select public.reply_person_message(:'run'::uuid,'I can help', (public.assist_request_context(:'req'::uuid)->>'through_seq')::bigint, null, :'msg'::uuid)->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'::uuid), 'work_proposed', 'legitimate proposal authorization');
select is((select count(*) from public.agent_tasks where workspace_id=:'ws'::uuid), :'task_count'::bigint, 'proposal creates no work: legitimate');

-- pasted
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'Please prepare the page', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select public.post_agent_message(:'ws'::uuid, 'Another message', gen_random_uuid())->>'message_id' as other \gset
select tests.reset_role();
update public.agent_messages set pasted=true where id=:'msg'::uuid;
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner'::uuid and state='queued' \gset
select count(*) as task_count from public.agent_tasks where workspace_id=:'ws'::uuid \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid,'proposal-check')->>'run_id' as run \gset
select public.reply_person_message(:'run'::uuid,'I can help', (public.assist_request_context(:'req'::uuid)->>'through_seq')::bigint, null, :'msg'::uuid)->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'::uuid), 'reply', 'pasted proposal authorization');
select is((select count(*) from public.agent_tasks where workspace_id=:'ws'::uuid), :'task_count'::bigint, 'proposal creates no work: pasted');

-- forwarded
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'Please prepare the page', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select public.post_agent_message(:'ws'::uuid, 'Another message', gen_random_uuid())->>'message_id' as other \gset
select tests.reset_role();
update public.agent_messages set forwarded=true where id=:'msg'::uuid;
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner'::uuid and state='queued' \gset
select count(*) as task_count from public.agent_tasks where workspace_id=:'ws'::uuid \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid,'proposal-check')->>'run_id' as run \gset
select public.reply_person_message(:'run'::uuid,'I can help', (public.assist_request_context(:'req'::uuid)->>'through_seq')::bigint, null, :'msg'::uuid)->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'::uuid), 'reply', 'forwarded proposal authorization');
select is((select count(*) from public.agent_tasks where workspace_id=:'ws'::uuid), :'task_count'::bigint, 'proposal creates no work: forwarded');

-- another person
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'Please prepare the page', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select public.post_agent_message(:'ws'::uuid, 'Another message', gen_random_uuid())->>'message_id' as other \gset
select tests.reset_role();
update public.agent_messages set user_id=:'viewer'::uuid where id=:'other'::uuid;
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner'::uuid and state='queued' \gset
select count(*) as task_count from public.agent_tasks where workspace_id=:'ws'::uuid \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid,'proposal-check')->>'run_id' as run \gset
select public.reply_person_message(:'run'::uuid,'I can help', (public.assist_request_context(:'req'::uuid)->>'through_seq')::bigint, null, :'other'::uuid)->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'::uuid), 'reply', 'another person proposal authorization');
select is((select count(*) from public.agent_tasks where workspace_id=:'ws'::uuid), :'task_count'::bigint, 'proposal creates no work: another person');

-- inaccessible
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'Please prepare the page', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select public.post_agent_message(:'ws'::uuid, 'Another message', gen_random_uuid())->>'message_id' as other \gset
select tests.reset_role();
update public.private_pages set owner_user_id=:'viewer'::uuid where page_id='page_B';
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner'::uuid and state='queued' \gset
select count(*) as task_count from public.agent_tasks where workspace_id=:'ws'::uuid \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid,'proposal-check')->>'run_id' as run \gset
select public.reply_person_message(:'run'::uuid,'I can help', (public.assist_request_context(:'req'::uuid)->>'through_seq')::bigint, null, :'msg'::uuid)->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'::uuid), 'reply', 'inaccessible proposal authorization');
select is((select count(*) from public.agent_tasks where workspace_id=:'ws'::uuid), :'task_count'::bigint, 'proposal creates no work: inaccessible');
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$select public.assist_request_context(%L)$q$, :'req')), 'PT404', 'a person cannot call the agent context RPC');
select tests.reset_role();
-- A backlog must not acknowledge requests the model has not received.
update public.agent_messages set created_at=now()-interval '2 minutes' where user_id=:'owner'::uuid;
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'guarda en notas: oldest request', gen_random_uuid())->>'message_id' as oldest \gset
select public.post_agent_message(:'ws'::uuid, 'queued ' || n, gen_random_uuid()) from generate_series(1,20) n;
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner'::uuid and state='queued' \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.claim_task(:'req'::uuid,'backlog-check')->>'run_id' as run \gset
select public.assist_request_context(:'req'::uuid) as batch \gset
select ok(exists(select 1 from jsonb_array_elements(:'batch'::jsonb->'messages') m where m->>'id'=:'oldest'), 'oldest pending save is included in the first batch');
select public.reply_person_message(:'run'::uuid,'Batch answered',(:'batch'::jsonb->>'through_seq')::bigint,null);
select tests.reset_role();
select is((select count(*) from public.agent_messages where user_id=:'owner'::uuid and needs_reply),1::bigint,'unseen backlog remains pending');
select * from finish();
rollback;
