-- Questions that do not block: the task keeps its state, the run keeps running, the answer arrives as an activity
-- and an event linked to the question, the question outlives a run that sends the task back to the queue, and it
-- dies with a task that stops, fails or loses its agent.
begin;
select plan(37);

select tests.fixture() as f \gset
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Draft the newsletter"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset

-- A. Asking without blocking.
select public.request_input(:'run'::uuid, 'Formal or casual?', array['respond','ignore'], 'elicitation', false) as q \gset
select is((:'q'::jsonb ->> 'blocking')::boolean, false, 'request_input with blocking false says so');
select is(:'q'::jsonb ->> 'status', 'pending', 'the question is pending');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'working', 'the task stays working');
select is((select status from public.agent_runs where id = :'run'::uuid), 'running', 'the run keeps running');
select is((select blocking from public.agent_approvals where id = (:'q'::jsonb->>'approval_id')::uuid), false, 'the approval row does not block');
select is((select (body->>'blocking')::boolean from public.agent_activities where task_id = :'task'::uuid and type = 'elicitation'), false,
          'the elicitation activity carries blocking false');
select is((select payload->>'blocking' from public.notifications where approval_id = (:'q'::jsonb->>'approval_id')::uuid), 'false',
          'the owner is notified, marked as not blocking');

-- B. A wait that ends goes back to running even with a question that does not block.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.touch_run_wait(:'run'::uuid, :'task'::uuid);
select public.touch_run_wait(:'run'::uuid, null);
select tests.reset_role();
select is((select status from public.agent_runs where id = :'run'::uuid), 'running', 'touch_run_wait ignores questions that do not block');

-- C. Without the flag a question still blocks.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_input(:'run'::uuid, 'Which list?') ->> 'approval_id' as qb \gset
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'input_required', 'a question without the flag still blocks');
select is((select blocking from public.agent_approvals where id = :'qb'::uuid), true, 'blocking defaults to true');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'qb'::uuid, 'respond', '{"text":"The October list"}'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'working', 'answering the blocking question resumes the task');

-- D. The answer to the question that does not block.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval((:'q'::jsonb->>'approval_id')::uuid, 'respond', '{"text":"Casual"}'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'working', 'answering it leaves the task state alone');
select is((select body->>'text' from public.agent_activities
            where task_id = :'task'::uuid and type = 'prompt' and body->>'approval_id' = :'q'::jsonb->>'approval_id'), 'Casual',
          'the answer is a prompt activity linked to the question');
select is((select payload->>'blocking' from public.agent_events
            where task_id = :'task'::uuid and type = 'approval.decided' and payload->>'approval_id' = :'q'::jsonb->>'approval_id'), 'false',
          'the approval.decided event says the question did not block');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select x->>'approval_id' from jsonb_array_elements(public.heartbeat(:'run'::uuid, null, 0) -> 'pending_prompts') x
            where x->>'text' = 'Casual'), :'q'::jsonb->>'approval_id', 'heartbeat hands the answer over with its approval_id');

-- E. The question outlives a run that sends the task back to the queue.
select public.request_input(:'run'::uuid, 'Add a P.S.?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q2 \gset
select public.end_run(:'run'::uuid, 'completed');
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'q2'::uuid), 'pending', 'end_run leaves a question that does not block pending');
select is((select run_id::text from public.agent_approvals where id = :'q2'::uuid), null::text, 'the question is detached from the ended run');
select is((select state from public.agent_tasks where id = :'task'::uuid), 'queued', 'the task went back to the queue');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q2'::uuid, 'respond', '{"text":"Yes, a short one"}'::jsonb);
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'queued', 'an answer after the run ended does not change the task state');
select ok(exists (select 1 from public.agent_events where task_id = :'task'::uuid and type = 'approval.decided'
                   and payload->>'approval_id' = :'q2' and run_id is null and agent_id = (:'f'::jsonb->>'agent')::uuid),
          'the delegate still gets approval.decided for a late answer');

-- F. The next run reads the late answer; a question that blocks still dies with its run.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run2 \gset
select is((select run_id from public.agent_approvals where id = :'q2'::uuid), :'run2'::uuid,
          'the claim binds the question answered while no run was active to the new run');
select is((select response->>'text' from public.agent_approvals
            where id = :'q2'::uuid and decided_at >= (select max(ended_at) from public.agent_runs where task_id = :'task'::uuid)),
          'Yes, a short one', 'the new run reads the late answer, newer than the end of the last run');
select public.request_input(:'run2'::uuid, 'Which date?') ->> 'approval_id' as q3 \gset
select public.end_run(:'run2'::uuid, 'completed');
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'q3'::uuid), 'cancelled', 'end_run still cancels a question that blocks');

-- G. The handover treats questions that do not block as such.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run3 \gset
select public.request_input(:'run3'::uuid, 'Any image?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q4 \gset
select public.hand_over(:'run3'::uuid, '{"v":1,"next_step":"Write the outro","handover_note":"Back to the queue"}'::jsonb, 'ho-1');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'queued',
          'hand_over with only a question that does not block pending leaves the task queued');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run4 \gset
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'working',
          'claiming with only a question that does not block pending starts working');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.release_for_handover(:'task'::uuid, null, 'Someone else, please');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'task'::uuid), 'queued',
          'release_for_handover with only a question that does not block pending leaves the task queued');

-- H. Only a signed-in person answers.
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.decide_approval(%L::uuid, %L, %L::jsonb)', :'q4', 'respond', '{"text":"x"}')), '42501',
          'a signed-out caller cannot answer');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L, %L::jsonb)', :'q4', 'respond', '{"text":"x"}')), 'humans_only',
          'an agent cannot answer a question');
select tests.reset_role();

-- I. Out of independent work, the agent makes its open questions block; a question is answered once, from any session of a person.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run5 \gset
select public.await_questions(:'run5'::uuid) as aw \gset
select tests.reset_role();
select is((:'aw'::jsonb ->> 'questions')::int, 1, 'await_questions turns the one open question into a blocking one');
select is((select blocking from public.agent_approvals where id = :'q4'::uuid), true, 'the question now blocks');
select is((select t.state || '/' || r.status from public.agent_tasks t join public.agent_runs r on r.id = t.active_run_id
            where t.id = :'task'::uuid), 'input_required/waiting', 'the task waits on a person and the run waits');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q4'::uuid, 'respond', '{"text":"No image"}'::jsonb);
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L, %L::jsonb)', :'q4', 'respond', '{"text":"again"}')),
          'approval_not_pending', 'a question answered once cannot be answered again');
select tests.reset_role();
select is((select t.state || '/' || r.status from public.agent_tasks t join public.agent_runs r on r.id = t.active_run_id
            where t.id = :'task'::uuid), 'working/running', 'the answer resumes the task and the run');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_input(:'run5'::uuid, 'Which subject line?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q5 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1');
select is(public.decide_approval(:'q5'::uuid, 'respond', '{"text":"Short"}'::jsonb) ->> 'status', 'decided',
          'a chat session acting as the owner can answer a question');
select tests.reset_role();

-- J. A question that does not block dies with a task that stops, fails or loses its agent.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A2','page_A3','page_A4']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+second@agents.invalid', 'worker', 'page_A') as a2 \gset
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A2', '{"objective":"Stopped task"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_stop \gset
select public.create_agent_task('page_A3', '{"objective":"Failed task"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_fail \gset
select public.create_agent_task('page_A4', '{"objective":"Revoked task"}'::jsonb, (:'a2'::jsonb->>'agent')::uuid) ->> 'task_id' as t_rev \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_stop'::uuid, 'custom') ->> 'run_id' as r_stop \gset
select public.request_input(:'r_stop'::uuid, 'Keep the logo?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_stop \gset
select public.claim_task(:'t_fail'::uuid, 'custom') ->> 'run_id' as r_fail \gset
select public.request_input(:'r_fail'::uuid, 'Which font?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_fail \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'t_stop'::uuid, 'Stop, please', 'stop');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.end_run(:'r_stop'::uuid, 'cancelled');
select public.end_run(:'r_fail'::uuid, 'error', 'boom', null, true);
select tests.reset_role();
select tests.set_agent((:'a2'::jsonb->>'user')::uuid, (:'a2'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_rev'::uuid, 'custom') ->> 'run_id' as r_rev \gset
select public.request_input(:'r_rev'::uuid, 'Which region?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_rev \gset
select public.end_run(:'r_rev'::uuid, 'completed');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revoke_agent((:'a2'::jsonb->>'agent')::uuid, 'no longer needed');
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'q_stop'::uuid), 'cancelled',
          'a run that ends on a stop cancels its question that does not block');
select is((select status from public.agent_approvals where id = :'q_fail'::uuid), 'cancelled',
          'a run that fails the task cancels its question that does not block');
select is((select status from public.agent_approvals where id = :'q_rev'::uuid), 'cancelled',
          'revoking the agent cancels its detached question');

select * from finish();
rollback;
