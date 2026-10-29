-- Questions that do not block: the task keeps its state, the run keeps running, the answer arrives as an activity
-- and an event linked to the question, the question outlives a run that sends the task back to the queue, and it
-- dies with a task that stops, fails, is delivered or loses its agent.
begin;
select plan(58);

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
select is((select status || '/' || (response->>'text') from public.agent_approvals where id = :'q2'::uuid),
          'decided/Yes, a short one', 'the late answer stays on the question bound to the new run');
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

-- K. With two questions awaited, answering one keeps the task waiting on a person; the last answer resumes it.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A')
  from unnest(array['page_A5','page_A6','page_A7','page_A8','page_A9','page_A10']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+third@agents.invalid', 'worker', 'page_A') as a3 \gset
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A5', '{"objective":"Two questions"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_two \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_two'::uuid, 'custom') ->> 'run_id' as r_two \gset
select public.request_input(:'r_two'::uuid, 'Formal or casual?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_two1 \gset
select public.request_input(:'r_two'::uuid, 'Add a P.S.?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_two2 \gset
select public.await_questions(:'r_two'::uuid);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q_two1'::uuid, 'respond', '{"text":"Casual"}'::jsonb);
select tests.reset_role();
select is((select t.state || '/' || r.status from public.agent_tasks t join public.agent_runs r on r.id = t.active_run_id
            where t.id = :'t_two'::uuid), 'input_required/waiting', 'answering one of two awaited questions keeps the task and the run waiting');
select is((select blocking::text || '/' || status from public.agent_approvals where id = :'q_two2'::uuid), 'true/pending',
          'the other question still blocks');
select ok(exists (select 1 from public.agent_activities where task_id = :'t_two'::uuid and type = 'prompt' and body->>'approval_id' = :'q_two1'),
          'the first answer still reaches the agent');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q_two2'::uuid, 'ignore');
select tests.reset_role();
select is((select t.state || '/' || r.status from public.agent_tasks t join public.agent_runs r on r.id = t.active_run_id
            where t.id = :'t_two'::uuid), 'working/running', 'the last answer resumes the task and the run');

-- L. Only the run's agent makes its questions block.
select tests.set_agent((:'a3'::jsonb->>'user')::uuid, (:'a3'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.await_questions(%L::uuid)', :'r_two')), 'forbidden', 'another agent cannot make my questions block');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.await_questions(%L::uuid)', :'r_two')), '42501', 'a signed-out caller cannot call await_questions');
select tests.reset_role();

-- M. A delivery ends the run: a question still open dies with it, so a late answer cannot take the task out of review.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A6', '{"objective":"Deliver with a question open","done_when":[{"id":"c1","text":"Plan drafted","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_sub \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_sub'::uuid, 'custom') ->> 'run_id' as r_sub \gset
select public.request_input(:'r_sub'::uuid, 'Add a P.S.?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_sub \gset
select public.add_artifact(:'r_sub'::uuid, 'page', 'page_A6', 'Plan', array['c1']) ->> 'artifact_id' as art_sub \gset
select public.submit_for_review(:'r_sub'::uuid, 'Done', array[:'art_sub'::uuid]);
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'q_sub'::uuid), 'cancelled', 'submit_for_review cancels a question still open');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L, %L::jsonb)', :'q_sub', 'respond', '{"text":"Yes"}')),
          'approval_not_pending', 'nobody can answer it any more');
select tests.reset_role();
select is((select state from public.agent_tasks where id = :'t_sub'::uuid), 'ready_for_review', 'the task stays under review');

-- N. A run that an error activity ends treats its questions like end_run; revoking the agent ends what is left.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A7', '{"objective":"Fails by an error activity"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_ef \gset
select public.create_agent_task('page_A8', '{"objective":"Waits, then errs"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_eb \gset
select public.create_agent_task('page_A9', '{"objective":"Requeued by an error activity"}'::jsonb, (:'a3'::jsonb->>'agent')::uuid) ->> 'task_id' as t_eq \gset
select public.create_agent_task('page_A10', '{"objective":"Run closed by housekeeping"}'::jsonb, (:'a3'::jsonb->>'agent')::uuid) ->> 'task_id' as t_dead \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_ef'::uuid, 'custom') ->> 'run_id' as r_ef \gset
select public.request_input(:'r_ef'::uuid, 'Which font?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_ef \gset
select public.post_activity(:'r_ef'::uuid, 'error', '{"code":"boom","message":"boom","recoverable":false,"terminal":true}'::jsonb);
select public.claim_task(:'t_eb'::uuid, 'custom') ->> 'run_id' as r_eb \gset
select public.request_input(:'r_eb'::uuid, 'Which list?') ->> 'approval_id' as q_eb \gset
select public.post_activity(:'r_eb'::uuid, 'error', '{"code":"boom","message":"boom","recoverable":false}'::jsonb);
select tests.reset_role();
select tests.set_agent((:'a3'::jsonb->>'user')::uuid, (:'a3'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_eq'::uuid, 'custom') ->> 'run_id' as r_eq \gset
select public.request_input(:'r_eq'::uuid, 'Which region?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_eq \gset
select public.post_activity(:'r_eq'::uuid, 'error', '{"code":"boom","message":"boom","recoverable":false}'::jsonb);
select public.claim_task(:'t_dead'::uuid, 'custom') ->> 'run_id' as r_dead \gset
select public.request_input(:'r_dead'::uuid, 'Which date?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_dead \gset
select tests.reset_role();
-- What housekeeping does to a run stopped without an acknowledgement: run and task end, the question stays.
update public.agent_runs set status = 'cancelled', ended_at = now() where id = :'r_dead'::uuid;
update public.agent_tasks set state = 'cancelled', active_run_id = null where id = :'t_dead'::uuid;
select is((select state from public.agent_tasks where id = :'t_ef'::uuid), 'failed', 'a terminal error activity fails the task');
select is((select status from public.agent_approvals where id = :'q_ef'::uuid), 'cancelled',
          'and cancels its question that does not block');
select is((select state || '/' || coalesce(waiting_on, '-') from public.agent_tasks where id = :'t_eb'::uuid), 'queued/-',
          'an error activity sends a task that waited on a person back to the queue');
select is((select status from public.agent_approvals where id = :'q_eb'::uuid), 'cancelled', 'and cancels the question that blocked');
select is((select status || '/' || coalesce(run_id::text, 'detached') from public.agent_approvals where id = :'q_eq'::uuid), 'pending/detached',
          'a question that does not block outlives an error activity that requeues the task, detached from the run');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revoke_agent((:'a3'::jsonb->>'agent')::uuid, 'no longer needed');
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'q_eq'::uuid), 'cancelled', 'revoking the agent cancels that question');
select is((select status from public.agent_approvals where id = :'q_dead'::uuid), 'cancelled',
          'and one left on a run that ended without cleaning up');

-- O. A delivery waits for the last blocking answer, and says which requests still block.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_A11','page_A12']) p;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A11', '{"objective":"Deliver after two questions","done_when":[{"id":"c1","text":"Drafted","check":"lead"}]}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_wait \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_wait'::uuid, 'custom') ->> 'run_id' as r_wait \gset
select public.request_input(:'r_wait'::uuid, 'Formal or casual?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_wait1 \gset
select public.request_input(:'r_wait'::uuid, 'Add a P.S.?', array['respond','ignore'], 'elicitation', false) ->> 'approval_id' as q_wait2 \gset
select public.add_artifact(:'r_wait'::uuid, 'page', 'page_A11', 'Draft', array['c1']) ->> 'artifact_id' as art_wait \gset
select public.await_questions(:'r_wait'::uuid);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q_wait1'::uuid, 'respond', '{"text":"Casual"}'::jsonb);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.submit_for_review(%L::uuid, %L, array[%L::uuid])', :'r_wait', 'Done', :'art_wait')),
          'waiting_on_human', 'a delivery waits while another request still blocks');
select is(tests.detail_of(format('select public.submit_for_review(%L::uuid, %L, array[%L::uuid])', :'r_wait', 'Done', :'art_wait'))::jsonb,
          jsonb_build_object('approval_ids', jsonb_build_array(:'q_wait2'::text)), 'and names the requests that still block');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'q_wait2'::uuid, 'ignore');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.submit_for_review(:'r_wait'::uuid, 'Done', array[:'art_wait'::uuid]) ->> 'task_state', 'ready_for_review',
          'after the last answer the delivery goes through');
select tests.reset_role();

-- P. An error activity never queues a task that still waits on a person: here for a request outside the run, which
--    no RPC leaves today.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A12', '{"objective":"Errs while a request outside the run blocks"}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t_out \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t_out'::uuid, 'custom') ->> 'run_id' as r_out \gset
select public.request_input(:'r_out'::uuid, 'Which list?') ->> 'approval_id' as q_out \gset
select tests.reset_role();
update public.agent_approvals set run_id = null where id = :'q_out'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.post_activity(:'r_out'::uuid, 'error', '{"code":"boom","message":"boom","recoverable":false}'::jsonb);
select tests.reset_role();
select is((select state || '/' || coalesce(waiting_on, '-') || '/' || coalesce(active_run_id::text, 'no run') from public.agent_tasks
            where id = :'t_out'::uuid), 'input_required/human/no run', 'the task keeps waiting on the person, without the dead run');
select is((select status from public.agent_approvals where id = :'q_out'::uuid), 'pending', 'and the request stays open');

select * from finish();
rollback;
