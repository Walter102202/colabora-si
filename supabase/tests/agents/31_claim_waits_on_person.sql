begin;
select plan(15);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A2','page_A3','page_A4','page_A5','page_A6']) p;

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
select is(tests.detail_of(format('select public.claim_task(%L::uuid, %L)', :'blk', 'codex')), 'the task waits on a person: claim it after they answer',
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

select * from finish();
rollback;
