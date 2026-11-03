-- Visible summaries are the only authority approved by a direct person session.
begin;
select plan(30);
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer \gset
select tests.make_agent(:'ws', 'proposals@test.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform=true, sponsor_user_id=:'owner', rate_limit_per_min=1000 where id=:'pa';
select tests.set_human(:'owner');
select public.post_agent_message(:'ws', 'Do it', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner' and state='queued' \gset
select tests.set_agent(:'pu',:'pa');
select public.claim_task(:'req','test')->>'run_id' as run \gset
select (public.assist_request_context(:'req')->>'through_seq')::bigint as seq \gset
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L)',:'run','Offer',:'seq',:'msg','  ')), 'invalid_input','blank summary rejected');
select is(tests.error_of(format('select public.reply_person_message(%L,%L,%s,null,%L,null,%L)',:'run','Offer',:'seq',:'msg',repeat('x',601))), 'invalid_input','long summary rejected');
select public.reply_person_message(:'run','Offer',:'seq',null,:'msg',null,'  Create five offsite tasks on page B.  ')->>'message_id' as reply \gset
select tests.reset_role();
select is((select outcome->>'summary' from public.agent_messages where id=:'reply'),'Create five offsite tasks on page B.','trimmed visible summary saved');
select is((select outcome->>'page_title' from public.agent_messages where id=:'reply'),(select left(title,200) from public.pages where id='page_B'),'page title saved');
select is((select outcome->>'agent_id' from public.agent_messages where id=:'reply'),:'pa','delegate saved');
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'),'work_proposed','proposal saved');
select tests.set_agent(:'pu',:'pa');
select is(tests.error_of(format('select public.start_proposed_work(%L)',:'reply')),'humans_only','agents cannot approve');
select tests.reset_role();
select tests.set_human(:'viewer');
select is(tests.error_of(format('select public.start_proposed_work(%L)',:'reply')),'not_found','other person cannot approve');
select tests.set_human(:'owner','chat-client');
select is(tests.error_of(format('select public.start_proposed_work(%L)',:'reply')),'direct_session_required','OAuth cannot approve');
select tests.set_human(:'owner');
select public.start_proposed_work(:'reply') as started \gset
select tests.reset_role();
select is((select objective from public.task_briefs where task_id=(:'started'::jsonb->>'task_id')::uuid),'Create five offsite tasks on page B.','brief equals visible summary only');
select is((select delegate_agent_id::text from public.agent_tasks where id=(:'started'::jsonb->>'task_id')::uuid),:'pa','Trama delegated');
select is((select outcome->>'kind' from public.agent_messages where id=:'reply'),'work_started','settlement persisted');
select is((select outcome->>'task_id' from public.agent_messages where id=:'reply'),:'started'::jsonb->>'task_id','task link persisted');
select count(*) as before_count from public.agent_tasks where row_page_id='page_B' \gset
select tests.set_human(:'owner');
select is(public.start_proposed_work(:'reply'),:'started'::jsonb || '{"already_started":true}'::jsonb,'second approval returns same task');
select tests.reset_role();
select is((select count(*) from public.agent_tasks where row_page_id='page_B'),:'before_count'::bigint,'no duplicate task');
update public.agent_tasks set state='done' where id=(:'started'::jsonb->>'task_id')::uuid;
select tests.set_human(:'viewer');
select is(tests.error_of(format('select public.send_agent_message(%L,%L,%L)',:'started'::jsonb->>'task_id','','continue')),'forbidden','authorize before disclosing the task continuation rule');
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.send_agent_message(%L,%L,%L)',:'started'::jsonb->>'task_id','  ','continue')),'message_required','done needs text');
select is(tests.error_of(format('select public.send_agent_message(%L,%L,%L)',:'started'::jsonb->>'task_id','  ','feedback')),'message_required','done needs text for feedback');
select tests.reset_role();
update public.agent_tasks set state='ready_for_review' where id=(:'started'::jsonb->>'task_id')::uuid;
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.send_agent_message(%L,%L,%L)',:'started'::jsonb->>'task_id','','continue')),'message_required','review needs text');
select is(tests.error_of(format('select public.send_agent_message(%L,%L,%L)',:'started'::jsonb->>'task_id','','feedback')),'message_required','review needs text for feedback');
select tests.reset_role();
update public.agent_tasks set state='done' where id=(:'started'::jsonb->>'task_id')::uuid;
select tests.set_human(:'owner');
select public.send_agent_message((:'started'::jsonb->>'task_id')::uuid,'Change the dates','continue');
select tests.reset_role();
select is((select state from public.agent_tasks where id=(:'started'::jsonb->>'task_id')::uuid),'queued','text reopens');
select tests.set_human(:'owner');
select is(public.send_agent_message((:'started'::jsonb->>'task_id')::uuid,'','stop')->>'delivery','cancelled','stop still works');
select tests.reset_role();
select tests.set_human(:'owner');
select public.post_agent_message(:'ws', 'Original work', gen_random_uuid(), '{"page_id":"page_B"}')->>'message_id' as msg \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner' and state='queued' \gset
select tests.set_agent(:'pu',:'pa');
select public.claim_task(:'req','test')->>'run_id' as run \gset
select (public.assist_request_context(:'req')->>'through_seq')::bigint as seq \gset
select public.reply_person_message(:'run','Offer',:'seq',null,:'msg',null)->>'message_id' as legacy \gset
select tests.reset_role();
select ok(not (select outcome ? 'summary' from public.agent_messages where id=:'legacy'),'six-argument compatibility');
select tests.set_human(:'owner');
select public.start_proposed_work(:'legacy')->>'task_id' as legacy_task \gset
select tests.reset_role();
select is((select objective from public.task_briefs where task_id=:'legacy_task'),'Original work','legacy objective uses original');
update public.agent_tasks set state='done' where id=:'legacy_task';
-- Simulate an old proposal pointing at pasted content: never inherit its authority.
update public.agent_messages set pasted=true where id=:'msg';
update public.agent_messages set outcome=(outcome - 'task_id') || '{"kind":"work_proposed"}' where id=:'legacy';
select tests.set_human(:'owner');
select is(tests.error_of(format('select public.start_proposed_work(%L)',:'legacy')),'no_objective','legacy pasted text rejected');
select is(public.decline_proposed_work(:'legacy'),'{"declined":true}'::jsonb,'decline succeeds');
select is(tests.error_of(format('select public.start_proposed_work(%L)',:'legacy')),'already_settled','declined proposal cannot start');
select is(tests.error_of(format('select public.decline_proposed_work(%L)',:'legacy')),'already_settled','decline is settled once');
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'legacy'),'work_declined','decline persisted');
select tests.set_human(:'owner');
select public.post_agent_message(:'ws', 'Pasted request', gen_random_uuid(), '{"page_id":"page_B","pasted":true}')->>'message_id' as msg \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind='assist' and owner_user_id=:'owner' and state='queued' \gset
select tests.set_agent(:'pu',:'pa');
select public.claim_task(:'req','test')->>'run_id' as run \gset
select (public.assist_request_context(:'req')->>'through_seq')::bigint as seq \gset
select public.reply_person_message(:'run','Offer',:'seq',null,:'msg',null,'Create work on page B')->>'message_id' as pasted_reply \gset
select tests.reset_role();
select is((select outcome->>'kind' from public.agent_messages where id=:'pasted_reply'),'reply','pasted messages cannot authorize a proposal');
select * from finish();
rollback;
