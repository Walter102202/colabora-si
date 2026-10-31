-- Lessons: a correction queues a request for the platform agent, a proposal is inert until a person accepts it from a
-- direct session, and no trigger of this path can fail the correction that fired it.
begin;
select plan(46);

select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+platform@agents.invalid', 'lead', 'page_B') as pl \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
update public.agents set is_platform = true, capabilities = '{"start":true}'::jsonb where id = (:'pl'::jsonb->>'agent')::uuid;
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_DB', 'page_A',
  '{"id":"page_DB","title":"Reports","parentId":"page_A","blocks":[],"database":{"properties":[],"rows":[],"views":[]}}'::jsonb);
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_R1', 'page_DB');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_R2', 'page_DB');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_R3', 'page_DB');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_R4', 'page_DB');
-- Match the explicit As-you consent link required by the HTTP session hook.
insert into public.agent_oauth_links (user_id, client_id, as_human)
values ((:'f'::jsonb->>'owner')::uuid, 'chat-client', true);

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_R1', '{"objective":"Write the weekly report","done_when":[{"id":"c1","text":"Dates are right","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t1 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t1'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_R1', 'Report', '{c1}') ->> 'artifact_id' as art \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'art'::uuid]);
select tests.reset_role();

-- A. A review that asks for changes queues one request; the page keeps its work task.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'t1'::uuid, 'approved', '[{"criterion_id":"c1","status":"verified"}]'::jsonb);
select tests.reset_role();
select is((select count(*) from public.agent_tasks where request_kind = 'lesson' and workspace_id = (:'f'::jsonb->>'ws')::uuid), 0::bigint, 'an approved review queues nothing');
update public.agent_tasks set state = 'ready_for_review', review_state = 'pending' where id = :'t1'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'t1'::uuid, 'changes_requested', '[{"criterion_id":"c1","status":"contradicted"}]'::jsonb);
select tests.reset_role();
select is((select count(*) from public.agent_tasks where request_kind = 'lesson' and workspace_id = (:'f'::jsonb->>'ws')::uuid), 0::bigint, 'a review without a note teaches nothing');
update public.agent_tasks set state = 'ready_for_review', review_state = 'pending' where id = :'t1'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'t1'::uuid, 'changes_requested',
  '[{"criterion_id":"c1","status":"contradicted","note":"Dates must be DD/MM/YYYY"}]'::jsonb) ->> 'review_id' as rv \gset
select tests.reset_role();
select id as req from public.agent_tasks where request_kind = 'lesson' and workspace_id = (:'f'::jsonb->>'ws')::uuid \gset
select is((select delegate_agent_id from public.agent_tasks where id = :'req'::uuid), (:'pl'::jsonb->>'agent')::uuid, 'the platform agent gets the request');
select is((select owner_user_id from public.agent_tasks where id = :'req'::uuid), (:'f'::jsonb->>'owner')::uuid, 'the owner of the corrected task owns it');
select is((select request->>'task_id' from public.agent_tasks where id = :'req'::uuid), :'t1', 'the request names the corrected task');
select is((select request->>'source_kind' from public.agent_tasks where id = :'req'::uuid), 'review', 'and what kind of correction it was');
select is((select count(*) from public.agent_events where task_id = :'req'::uuid and type = 'task.start'), 1::bigint, 'the agent is woken');
select is((select count(*) from public.agent_grants where agent_id = (:'pl'::jsonb->>'agent')::uuid and page_id = 'page_R1'), 0::bigint,
          'the request adds no page grant');
select is((select state from public.agent_tasks where id = :'t1'::uuid), 'queued', 'the corrected task went on as before');

-- B. One open request per page, a person's feedback, and what does not count.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'t1'::uuid, 'Use the client logo too', 'feedback');
select tests.reset_role();
select is((select count(*) from public.agent_tasks where request_kind = 'lesson' and workspace_id = (:'f'::jsonb->>'ws')::uuid), 1::bigint, 'an open request takes the next correction');
select is(private.review_correction_text('[{"criterion_id":"c1","status":"contradicted","severity":"minor","note":"Nit"}]'::jsonb), null, 'a minor finding teaches nothing');
select is(private.is_correction('prompt', 'human', '{"signal":"feedback","text":"x"}'::jsonb), true, 'a person''s feedback is a correction');
select is(private.is_correction('prompt', 'agent', '{"signal":"feedback","text":"x"}'::jsonb), false, 'an agent''s message is not');
select is(private.is_correction('prompt', 'human', '{"signal":"continue","text":"x"}'::jsonb), false, 'continue is not');
select is(private.is_correction('prompt', 'human', '{"signal":"feedback","text":"  "}'::jsonb), false, 'an empty note is not');
select is(private.is_correction('prompt', 'human', '{"signal":"feedback","text":"x","close":"accepted"}'::jsonb), false, 'an accepted close is not');
select is(private.is_correction('prompt', 'human', '{"signal":"feedback","text":"x","close":"rejected"}'::jsonb), true, 'a rejected close is');
select is(private.is_correction('prompt', 'human', '{"signal":"feedback","text":"x","review_id":"1"}'::jsonb), false, 'a review prompt counts once, by its review');
select is(private.is_correction('prompt', 'human', '{"signal":"feedback","text":"x","subtask_id":"1"}'::jsonb), false, 'the parent''s copy does not count');

-- C. The run reads the correction and proposes; a proposal needs a Lead, a run and a correction.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.lesson_request_context(%L::uuid)', :'req')), 'not_found', 'only the delegate reads the request');
select public.claim_task(:'t1'::uuid, 'codex') ->> 'run_id' as w2 \gset
select is(tests.error_of(format($$select public.propose_lesson(%L::uuid, 'Check the dates')$$, :'w2')), 'lead_only', 'a worker cannot propose');
select tests.reset_role();
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select public.claim_task(:'req'::uuid, 'platform') ->> 'run_id' as pr \gset
select ok((public.lesson_request_context(:'req'::uuid))->'corrections' @> '[{"text":"c1 contradicted: Dates must be DD/MM/YYYY","kind":"review"}]', 'it reads what the reviewer said');
select ok((public.lesson_request_context(:'req'::uuid))->'corrections' @> '[{"text":"Use the client logo too","kind":"feedback"}]', 'and the later feedback');
select is(tests.error_of(format($$select public.propose_lesson(%L::uuid, '   ')$$, :'pr')), 'invalid_input', 'a lesson needs text');
select public.propose_lesson(:'pr'::uuid, 'Write dates as DD/MM/YYYY in client reports', 'Use 30/10/2026, not 10/30/2026', null, null, null, 'k1') ->> 'lesson_id' as l1 \gset
select is(public.propose_lesson(:'pr'::uuid, 'Write dates as DD/MM/YYYY in client reports', 'Other', null, null, null, 'k1') ->> 'lesson_id', :'l1', 'a repeated key returns the first answer');
select is((public.propose_lesson(:'pr'::uuid, 'write dates as dd/mm/yyyy in client reports')) ->> 'duplicate', 'true', 'the same lesson twice is one lesson');
select public.complete_lesson_request(:'pr'::uuid, 'Proposed one lesson');
select tests.reset_role();
select is((select status || ':' || scope || ':' || scope_page_id from public.lessons where id = :'l1'::uuid), 'proposed:page:page_DB',
          'it starts proposed, scoped to the database');
select ok((select source_text in ('Use the client logo too', 'c1 contradicted: Dates must be DD/MM/YYYY') from public.lessons where id = :'l1'::uuid), 'the server copied the correction');
select is((select state || ':' || acceptance from public.agent_tasks where id = :'req'::uuid), 'done:accepted', 'the request closed');
select is((select count(*) from public.notifications where kind = 'lesson_proposed' and workspace_id = (:'f'::jsonb->>'ws')::uuid and user_id = (:'f'::jsonb->>'owner')::uuid), 1::bigint, 'the owner is told');

-- D. Who decides. Only a person, only from a direct session, and an agent never browses the table.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.decide_lesson(%L::uuid, 'accept')$$, :'l1')), 'humans_only', 'an agent cannot accept');
select is((select count(*) from public.lessons), 0::bigint, 'an agent reads no lesson from the table');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'chat-client');
select is(tests.error_of(format($$select public.decide_lesson(%L::uuid, 'accept')$$, :'l1')), 'direct_session_required', 'a chat session cannot accept');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'dead-client');
select is((select count(*) from public.lessons), 0::bigint, 'a chat without a live link reads no lesson');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format($$select public.decide_lesson(%L::uuid, 'accept')$$, :'l1')), 'forbidden', 'a viewer cannot accept');
select is((select count(*) from public.lessons where id = :'l1'::uuid), 1::bigint, 'but can read it');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format($$select public.decide_lesson(%L::uuid, 'accept')$$, :'l1')), '42501', 'a signed-out caller cannot call it');
select tests.reset_role();

-- E. Accepting, narrowing, revising and retiring.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_lesson(:'l1'::uuid, 'accept', null, null, 'context');
select is(tests.error_of(format($$select public.decide_lesson(%L::uuid, 'dismiss')$$, :'l1')), 'lesson_already_decided', 'a decision is final');
select tests.reset_role();
select is((select status || ':' || scope || ':' || (scope_context_id = (select context_id from public.agent_tasks where id = :'t1'::uuid))
             from public.lessons where id = :'l1'::uuid), 'accepted:context:true', 'narrowed to the project');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revise_lesson(:'l1'::uuid, 'Dates are DD/MM/YYYY', null, 'page', 'page_DB') ->> 'lesson_id' as l2 \gset
select tests.reset_role();
select is((select status from public.lessons where id = :'l1'::uuid), 'superseded', 'a revision replaces the lesson');
select is((select supersedes_id::text || ':' || scope_page_id from public.lessons where id = :'l2'::uuid), :'l1' || ':page_DB', 'and points at it');
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format($$select public.create_lesson(%L::uuid, 'x')$$, :'f'::jsonb->>'ws')), 'forbidden', 'a viewer cannot write a lesson');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.retire_lesson(:'l2'::uuid);
select is(tests.error_of(format($$select public.retire_lesson(%L::uuid)$$, :'l2')), 'lesson_not_accepted', 'a retired lesson stays retired');
select tests.reset_role();

-- G. Expiry. A queued lesson waits for the platform agent, a rewrite does not, and a silent run never holds a request.
select private.insert_system_request((:'f'::jsonb->>'ws')::uuid, 'page_R2', 'lesson', (:'f'::jsonb->>'owner')::uuid,
  (select a from public.agents a where a.id = (:'pl'::jsonb->>'agent')::uuid), 'Queued', '{"objective":"Queued"}'::jsonb, '{}'::jsonb) as q_lesson \gset
select private.insert_system_request((:'f'::jsonb->>'ws')::uuid, 'page_R3', 'rewrite', (:'f'::jsonb->>'owner')::uuid,
  (select a from public.agents a where a.id = (:'pl'::jsonb->>'agent')::uuid), 'Queued', '{"objective":"Queued"}'::jsonb, '{}'::jsonb) as q_rewrite \gset
select private.insert_system_request((:'f'::jsonb->>'ws')::uuid, 'page_R4', 'lesson', (:'f'::jsonb->>'owner')::uuid,
  (select a from public.agents a where a.id = (:'pl'::jsonb->>'agent')::uuid), 'Silent', '{"objective":"Silent"}'::jsonb, '{}'::jsonb) as q_silent \gset
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select public.claim_task(:'q_silent'::uuid) ->> 'run_id' as silent_run \gset
select tests.reset_role();
update public.agent_tasks set updated_at = now() - interval '16 minutes', created_at = now() - interval '16 minutes'
 where id in (:'q_lesson'::uuid, :'q_rewrite'::uuid, :'q_silent'::uuid);
update public.agent_runs set last_signal_at = now() - interval '16 minutes' where id = :'silent_run'::uuid;
select private.agent_housekeeping();
select is((select state from public.agent_tasks where id = :'q_lesson'::uuid), 'queued', 'a queued lesson does not expire');
select is((select state from public.agent_tasks where id = :'q_rewrite'::uuid), 'failed', 'a queued rewrite still does');
select is((select t.state || '/' || r.status from public.agent_tasks t join public.agent_runs r on r.task_id = t.id where r.id = :'silent_run'::uuid),
          'failed/error', 'and a lesson whose run went silent expires too');

select * from finish();
rollback;
