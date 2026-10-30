begin;
select plan(30);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A2','page_A3','page_A4','page_A5','page_A6','page_A7','page_A8','page_A9','page_A10']) p;

-- A blocked review and a handover leave the same fields: input_required, waiting_on human, no run. Only a pending
-- blocking question (private.task_waits_on_human) tells the handover apart, so claim_task decides by it.

-- 1-5. A task blocked in review waits for the person's message; the message requeues it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A2', '{"objective":"Draft the memo"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as blk \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'blk'::uuid, 'codex') ->> 'run_id' as w1 \gset
select public.add_artifact(:'w1'::uuid, 'page', 'page_A2', 'Memo', '{}') ->> 'artifact_id' as art1 \gset
select public.submit_for_review(:'w1'::uuid, 'v1', array[:'art1'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'blk'::uuid, 'blocked', '[]'::jsonb, '[]'::jsonb, :'art1'::uuid);
select tests.reset_role();
select is((select state || '/' || waiting_on || '/' || coalesce(active_run_id::text, 'no run') from public.agent_tasks where id = :'blk'::uuid),
          'input_required/human/no run', 'a blocked task waits on a person without a run');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'blk', 'codex')), 'task_unavailable', 'a session cannot claim a blocked task');
select is(tests.detail_of(format('select public.claim_task(%L::uuid, %L)', :'blk', 'codex')), 'the task waits on a person: claim it after they answer or continue it',
          'the refusal says why');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'blk'::uuid, 'Keep it to one page.', 'feedback');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'blk'::uuid), 'queued', 'the message of the person requeues the blocked task');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.claim_task(:'blk'::uuid, 'codex') ->> 'task_id', :'blk', 'then a session claims it');

-- 6. An escalation (changes requested past the round limit) waits on a person the same way.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A3', '{"objective":"Fix the table"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as esc \gset
select tests.reset_role();
update public.agent_tasks set max_review_rounds = 0 where id = :'esc'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'esc'::uuid, 'codex') ->> 'run_id' as w2 \gset
select public.add_artifact(:'w2'::uuid, 'page', 'page_A3', 'Table', '{}') ->> 'artifact_id' as art2 \gset
select public.submit_for_review(:'w2'::uuid, 'v1', array[:'art2'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.review_task(:'esc'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, :'art2'::uuid);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'esc', 'codex')), 'task_unavailable', 'a session cannot claim an escalated task');

-- 7-10. A handover with a pending blocking question (P4): the next session claims it, waits on the question in its
-- run, and resumes when the person answers.
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A4', '{"objective":"Send the invoice"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as ho \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ho'::uuid, 'claude_code') ->> 'run_id' as w3 \gset
select public.request_input(:'w3'::uuid, 'Which address?') ->> 'approval_id' as q3 \gset
select public.hand_over(:'w3'::uuid, '{"v":1,"next_step":"Send it to the address","handover_note":"Waiting for the address"}'::jsonb, 'ho-3');
select tests.reset_role();
select is((select state || '/' || waiting_on || '/' || coalesce(active_run_id::text, 'no run') from public.agent_tasks where id = :'ho'::uuid),
          'input_required/human/no run', 'a handover leaves the same fields as a blocked task');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ho'::uuid, 'codex') ->> 'run_id' as w4 \gset
select tests.reset_role();
select ok(:'w4' <> '', 'a session claims a handed-over task while its blocking question is pending');
select is((select r.status || '/' || t.state from public.agent_runs r join public.agent_tasks t on t.active_run_id = r.id where t.id = :'ho'::uuid),
          'waiting/input_required', 'the new run waits on the question');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q3'::uuid, 'respond', '{"text":"Main office"}'::jsonb);
select tests.reset_role();
select is((select r.status || '/' || t.state from public.agent_runs r join public.agent_tasks t on t.active_run_id = r.id where t.id = :'ho'::uuid),
          'running/working', 'the answer resumes the run');

-- 11-12. A handover answered before any session claims it: the answer requeues the task.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A5', '{"objective":"Book the room"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as ho2 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ho2'::uuid, 'claude_code') ->> 'run_id' as w5 \gset
select public.request_input(:'w5'::uuid, 'Which day?') ->> 'approval_id' as q5 \gset
select public.hand_over(:'w5'::uuid, '{"v":1,"next_step":"Book it","handover_note":"Waiting for the day"}'::jsonb, 'ho-5');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q5'::uuid, 'respond', '{"text":"Tuesday"}'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'ho2'::uuid), 'queued', 'answering the last blocking question requeues a task without a run');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ho2'::uuid, 'codex');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'ho2'::uuid), 'working', 'and a session claims it');

-- 13-15. A handover with only a question that does not block (P5): the task is queued, the question stays open.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A6', '{"objective":"Write the post"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as ho3 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ho3'::uuid, 'claude_code') ->> 'run_id' as w6 \gset
select public.request_input(:'w6'::uuid, 'Any image?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q6 \gset
select public.hand_over(:'w6'::uuid, '{"v":1,"next_step":"Write it","handover_note":"Off for today"}'::jsonb, 'ho-6');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'ho3'::uuid), 'queued', 'a handover with only a non-blocking question is queued');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'ho3'::uuid, 'codex');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'ho3'::uuid), 'working', 'a session claims it');
select is((select status from public.agent_approvals where id = :'q6'::uuid), 'pending', 'the question that does not block is still open');

-- 16-25. The Lead's message on a subtask that waits on a person is recorded for the next run but does not requeue it:
-- only a person's message does. The Lead cannot reopen a closed subtask either.
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
update public.agents set capabilities = '{"continue":true}'::jsonb where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A7', '{"objective":"Ship the report"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A8', '{"objective":"Write the report"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as s1 \gset
select public.create_subtask(:'parent'::uuid, 'page_A9', '{"objective":"Draw the chart"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as s2 \gset
select tests.reset_role();
update public.agent_tasks set max_review_rounds = 0 where id = :'s2'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'s1'::uuid, 'codex') ->> 'run_id' as w7 \gset
select public.add_artifact(:'w7'::uuid, 'page', 'page_A8', 'Report', '{}') ->> 'artifact_id' as art7 \gset
select public.submit_for_review(:'w7'::uuid, 'v1', array[:'art7'::uuid]);
select public.claim_task(:'s2'::uuid, 'codex') ->> 'run_id' as w8 \gset
select public.add_artifact(:'w8'::uuid, 'page', 'page_A9', 'Chart', '{}') ->> 'artifact_id' as art8 \gset
select public.submit_for_review(:'w8'::uuid, 'v1', array[:'art8'::uuid]);
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.review_task(:'s1'::uuid, 'blocked', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select public.review_task(:'s2'::uuid, 'changes_requested', '[]'::jsonb, '[]'::jsonb, null, :'lr'::uuid);
select is(public.send_agent_message(:'s1'::uuid, 'Use the 2025 figures.', 'feedback') ->> 'delivery', 'waiting_on_human',
          'the Lead''s message on a blocked subtask says that it waits on a person');
select is(public.send_agent_message(:'s2'::uuid, 'Go on.', 'continue') ->> 'delivery', 'waiting_on_human',
          'and so does its message on an escalated subtask');
select tests.reset_role();
select is((select string_agg(state || '/' || waiting_on, ',' order by title) from public.agent_tasks where id in (:'s1'::uuid, :'s2'::uuid)),
          'input_required/human,input_required/human', 'the Lead''s messages leave both subtasks waiting on a person');
select ok(not exists (select 1 from public.agent_events where task_id in (:'s1'::uuid, :'s2'::uuid) and type in ('task.feedback','task.continue')),
          'the worker is not woken by them');
select is((select count(*)::int from public.agent_activities where task_id in (:'s1'::uuid, :'s2'::uuid) and type = 'prompt' and author_type = 'agent'
                    and body->>'text' in ('Use the 2025 figures.', 'Go on.')), 2,
          'the messages are recorded for the next run');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'s1', 'codex')), 'task_unavailable', 'the worker still cannot claim the blocked subtask');
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'s2', 'codex')), 'task_unavailable', 'nor the escalated one');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.send_agent_message(:'s1'::uuid, 'Use the 2025 figures.', 'feedback') ->> 'delivery', 'dispatched', 'a person''s message requeues and wakes the worker');
select public.close_task(:'s2'::uuid, 'accepted');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'s1'::uuid), 'queued', 'the blocked subtask is queued again');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.send_agent_message(%L::uuid, %L, %L)', :'s2', 'One more pass', 'continue')), 'task_closed',
          'the Lead cannot reopen a subtask a person accepted');
select tests.reset_role();

-- 26-30. A handover whose blocking question expired waits on a person with nothing left to answer: no session may
-- take it, the refusal says the person can continue it, and Continue requeues it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A10', '{"objective":"Order the badges"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as exp \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'exp'::uuid, 'claude_code') ->> 'run_id' as w9 \gset
select public.request_input(:'w9'::uuid, 'How many badges?') ->> 'approval_id' as q9 \gset
select public.hand_over(:'w9'::uuid, '{"v":1,"next_step":"Order them","handover_note":"Waiting for the count"}'::jsonb, 'ho-9');
select tests.reset_role();
update public.agent_approvals set expires_at = now() - interval '1 minute' where id = :'q9'::uuid;
select private.agent_housekeeping();
select is((select a.status || '/' || t.state || '/' || t.waiting_on from public.agent_approvals a join public.agent_tasks t on t.id = a.task_id where a.id = :'q9'::uuid),
          'expired/input_required/human', 'the question expires and the task keeps waiting on a person');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L)', :'exp', 'codex')), 'task_unavailable', 'no session may claim it');
select is(tests.detail_of(format('select public.claim_task(%L::uuid, %L)', :'exp', 'codex')), 'the task waits on a person: claim it after they answer or continue it',
          'the refusal names Continue, the only way out');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'exp'::uuid, '', 'continue');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'exp'::uuid), 'queued', 'Continue requeues it');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.claim_task(:'exp'::uuid, 'codex') ->> 'task_id', :'exp', 'and a session claims it');
select tests.reset_role();

select * from finish();
rollback;
