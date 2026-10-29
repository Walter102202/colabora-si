begin;
select plan(63);

select tests.fixture() as f \gset
-- "claude_code" is the fixture agent; "codex" and "gemini" are agents with the same grant; "plain" has no resume capability.
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+codex@agents.invalid', 'worker', 'page_A') as cx \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+plain@agents.invalid', 'worker', 'page_A') as pl \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+gemini@agents.invalid', 'worker', 'page_A') as gm \gset
update public.agents set capabilities = '{"resume": true, "continue": true}'::jsonb
 where id in ((:'f'::jsonb->>'agent')::uuid, (:'cx'::jsonb->>'agent')::uuid, (:'gm'::jsonb->>'agent')::uuid);
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A2', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A3', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A5', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A6', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A7', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A8', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A9', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_A10', 'page_A');

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Draft and email the summary"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset

-- A. claude_code works: one write whose response arrives, one whose response is lost, one pending approval.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'claude_code', null, null, true) ->> 'run_id' as run1 \gset
select public.append_page_blocks('page_A1', '[{"type":"paragraph","spans":["Draft v1"]}]'::jsonb, null, 'k-draft') as w1 \gset
select public.append_page_blocks('page_A1', '[{"type":"paragraph","spans":["Section 2"]}]'::jsonb, null, 'k-sec2') as w2 \gset
select public.request_approval(:'run1'::uuid, 'send_email', '{"to":"team@example.com"}'::jsonb, null, 'Send the summary?') ->> 'approval_id' as ap \gset
select jsonb_build_object('v', 1, 'next_step', 'Write section 2, then email the team',
  'ops', jsonb_build_object(
    'confirmed', jsonb_build_array(jsonb_build_object('key','k-draft','tool','append_blocks','page_id','page_A1','block_ids', :'w1'::jsonb->'block_ids')),
    'pending',   jsonb_build_array(jsonb_build_object('key','k-sec2','tool','append_blocks','page_id','page_A1'),
                                   jsonb_build_object('key','k-never','tool','append_blocks','page_id','page_A1'))),
  'effects', jsonb_build_object('not_executed', jsonb_build_array(jsonb_build_object('action','send_email','approval_id', :'ap')))) as cpbody \gset

select ok((select pg_get_constraintdef(oid) from pg_constraint where conname = 'agent_activities_type_check') like '%checkpoint%handover%',
          'agent_activities_type_check lists checkpoint and handover');
select public.save_checkpoint(:'run1'::uuid, :'cpbody'::jsonb, 'cp-1') as cp1 \gset
select results_eq(format($q$ select type, ephemeral, body->>'v' from public.agent_activities where id = %L::uuid $q$, :'cp1'::jsonb->>'activity_id'),
                  $q$ values ('checkpoint'::text, true, '1'::text) $q$, 'save_checkpoint stores an ephemeral v1 checkpoint activity');
select is(public.save_checkpoint(:'run1'::uuid, '{"v":1,"next_step":"other"}'::jsonb, 'cp-1') ->> 'activity_id', :'cp1'::jsonb->>'activity_id',
          'the same idempotency key returns the first checkpoint');
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x","handover_note":null}', 'cp-null')), '',
          'a null handover_note reads as absent');
select public.post_activity(:'run1'::uuid, 'thought', '{"text":"Planning the summary"}'::jsonb, false, 'pa-1');
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x"}', 'pa-1')), 'idempotency_conflict',
          'save_checkpoint with a key another activity used is idempotency_conflict');
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, null)', :'run1', '{"v":1,"next_step":"x"}')), 'invalid_input',
          'save_checkpoint without an idempotency key is invalid_input');
select is(tests.detail_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1',
            '{"v":1,"next_step":"x","ops":{"pending":[{"key":"a","tool":"append_blocks","foo":1}]}}', 'cp-bad'))::jsonb ->> 'path',
          '$.ops.pending[0].foo', 'an unknown key is invalid_input with its path');
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":2,"next_step":"x"}', 'cp-v2')),
          'checkpoint_version_unsupported', 'a checkpoint with v 2 is checkpoint_version_unsupported');
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1',
            jsonb_build_object('v', 1, 'next_step', repeat('x', 2001)), 'cp-long')), 'invalid_input', 'next_step over 2000 characters is invalid_input');
select is(tests.detail_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1',
            jsonb_build_object('v', 1, 'next_step', 'x', 'ops', jsonb_build_object('confirmed', jsonb_build_array(
              jsonb_build_object('key', 'a', 'tool', 'append_blocks', 'block_ids', jsonb_build_array(repeat('b', 65)))))), 'cp-bid'))::jsonb ->> 'path',
          '$.ops.confirmed[0].block_ids[0]', 'a block id over 64 characters is invalid_input with its path');
select is(tests.detail_of(format($s$ select public.save_checkpoint(%L::uuid, jsonb_build_object('v', 1, 'next_step', 'x', 'ops', jsonb_build_object('pending',
            (select jsonb_agg(jsonb_build_object('key', 'k' || i, 'tool', 'append_blocks', 'block_ids',
               (select jsonb_agg(md5(i || '-' || j) || md5(j || '-' || i)) from generate_series(1, 200) j)))
               from generate_series(1, 60) i))), %L) $s$, :'run1', 'cp-big'))::jsonb ->> 'path',
          '$', 'a checkpoint over 256 KB is invalid_input at the root');
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x"}', 'cp-x')), 'forbidden',
          'another agent cannot save a checkpoint on this run');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.save_checkpoint(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x"}', 'cp-h')), 'agent_disabled',
          'a person calling save_checkpoint gets agent_disabled');

-- B. claude_code hands over voluntarily.
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.hand_over(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x","handover_note":"n"}', 'ho-x')), 'forbidden',
          'another agent cannot hand over this run');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.hand_over(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x","handover_note":"n"}', 'ho-h')), 'agent_disabled',
          'a person calling hand_over gets agent_disabled');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.hand_over(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x"}', 'ho-0')), 'invalid_input',
          'hand_over without a handover_note is invalid_input');
select is(tests.error_of(format('select public.hand_over(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x","handover_note":"n"}', 'pa-1')), 'idempotency_conflict',
          'hand_over with a key another activity used is idempotency_conflict');
select is(tests.error_of(format('select public.hand_over(%L::uuid, %L::jsonb, %L)', :'run1', '{"v":1,"next_step":"x","handover_note":"n"}', 'cp-1')), 'idempotency_conflict',
          'hand_over with the key of an intent checkpoint is idempotency_conflict, not a replayed handover');
select public.hand_over(:'run1'::uuid, :'cpbody'::jsonb || '{"handover_note":"Closing the laptop; section 2 may already be written"}'::jsonb, 'ho-1') as ho \gset
select tests.reset_role();
select results_eq(format($q$ select status, run_id from public.agent_approvals where id = %L::uuid $q$, :'ap'),
                  $q$ values ('pending'::text, null::uuid) $q$, 'hand_over keeps the pending approval, detached from the run');
select results_eq(format($q$ select r.status, t.state, t.waiting_on, t.active_run_id from public.agent_runs r, public.agent_tasks t
                            where r.id = %L::uuid and t.id = %L::uuid $q$, :'run1', :'task'),
                  $q$ values ('completed'::text, 'input_required'::text, 'human'::text, null::uuid) $q$,
                  'hand_over completes the run and, with a pending approval, the task waits on a person');
select is((select count(*)::int from public.agent_activities where task_id = :'task'::uuid and type = 'checkpoint' and (body->>'handover')::boolean and not ephemeral), 1,
          'hand_over writes one non-ephemeral checkpoint with handover true');

-- C. A person hands the task to codex.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.release_for_handover(%L::uuid, %L::uuid)', :'task', :'cx'::jsonb->>'agent')), 'humans_only',
          'an agent cannot call release_for_handover');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format('select public.release_for_handover(%L::uuid, null)', :'task')), 'forbidden',
          'a viewer cannot release a task for handover');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.release_for_handover(%L::uuid, %L::uuid)', :'task', '00000000-0000-4000-8000-00000000dead')),
          'delegate_not_found', 'release_for_handover to an unknown agent is delegate_not_found');
select public.release_for_handover(:'task'::uuid, (:'cx'::jsonb->>'agent')::uuid, 'Codex, please finish and send it') as rel \gset
select tests.reset_role();
select results_eq(format($q$ select delegate_agent_id, state, brief_version from public.agent_tasks where id = %L::uuid $q$, :'task'),
                  format($q$ values (%L::uuid, 'input_required'::text, 1) $q$, :'cx'::jsonb->>'agent'),
                  'release_for_handover re-delegates to codex without bumping the brief version');
select is((select count(*)::int from public.agent_events where task_id = :'task'::uuid and agent_id = (:'cx'::jsonb->>'agent')::uuid
             and type = 'task.continue' and (payload->>'handover')::boolean), 1, 'the new delegate gets task.continue with handover');

-- D. Involuntary: claude_code is still running task2 when a person releases it.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A2', '{"objective":"Second task","policies":{"preapproved":["post_slack"]}}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task2 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task2'::uuid, 'claude_code') ->> 'run_id' as run2 \gset
select public.begin_external_op(:'run2'::uuid, 'slack', 'post_slack', '{"channel":"team"}'::jsonb) ->> 'op_id' as op2 \gset
select public.save_checkpoint(:'run2'::uuid, '{"v":1,"next_step":"Post to Slack, then email"}'::jsonb, 'cp-t2') ->> 'activity_id' as cpt2 \gset
select public.request_approval(:'run2'::uuid, 'send_email', '{"to":"b@example.com"}'::jsonb, null, 'Send?') ->> 'approval_id' as ap2 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.release_for_handover(:'task2'::uuid, (:'cx'::jsonb->>'agent')::uuid, null) as rel2 \gset
select tests.reset_role();
select results_eq(format($q$ select status, stop_requested_at is not null from public.agent_runs where id = %L::uuid $q$, :'run2'),
                  $q$ values ('cancelled'::text, true) $q$, 'release_for_handover cancels the active run');
select is((select count(*)::int from public.agent_events where task_id = :'task2'::uuid and agent_id = (:'f'::jsonb->>'agent')::uuid
             and type = 'task.stop' and payload->>'reason' = 'handover'), 1, 'the old agent gets task.stop with reason handover');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select tests.error_of(format('select public.ack_stop(%L::uuid)', :'run2')) as ack_ignored \gset
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'ap2'::uuid), 'pending', 'the old agent''s ack_stop after release leaves the approval pending');

-- E. A task that is ready for review cannot be released.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A3', '{"objective":"Third task"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task3 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task3'::uuid, 'claude_code') ->> 'run_id' as run3 \gset
select public.add_artifact(:'run3'::uuid, 'page', 'page_A3', 'Result', '{}') ->> 'artifact_id' as art3 \gset
select public.submit_for_review(:'run3'::uuid, 'Done', array[:'art3'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.release_for_handover(%L::uuid, null)', :'task3')), 'invalid_state',
          'release_for_handover on a task ready for review is invalid_state');

-- F. codex resumes task 1 after a person edited the confirmed block.
select tests.reset_role();
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L, null, null, true)', :'task', 'custom')), 'resume_unsupported',
          'claim_task with resume by an agent without the capability is resume_unsupported');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.edit_block_text('page_A1', :'w1'::jsonb->'block_ids'->>0, 'Draft v1', 'Draft v1 (edited by a person)');
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'codex', null, null, true) as c2 \gset
select :'c2'::jsonb ->> 'run_id' as run4 \gset
select tests.reset_role();
select is((:'c2'::jsonb->'resume'->'checkpoint'->>'seq')::bigint,
          (select max(seq) from public.agent_activities where task_id = :'task'::uuid and type = 'checkpoint'),
          'claim_task with resume returns the latest checkpoint');
select results_eq(format($q$ select a.run_id, r.status, t.state from public.agent_approvals a, public.agent_runs r, public.agent_tasks t
                            where a.id = %L::uuid and r.id = %L::uuid and t.id = %L::uuid $q$, :'ap', :'run4', :'task'),
                  format($q$ values (%L::uuid, 'waiting'::text, 'input_required'::text) $q$, :'run4'),
                  'the pending approval is bound to the new run and the run waits');
select is((select x->>'status' from jsonb_array_elements(:'c2'::jsonb->'resume'->'pending_ops') x where x->>'key' = 'k-sec2'), 'confirmed',
          'a pending write with a receipt for the old agent is confirmed (its response was lost)');
select is((select x->>'status' from jsonb_array_elements(:'c2'::jsonb->'resume'->'pending_ops') x where x->>'key' = 'k-never'), 'not_executed',
          'a pending write without a receipt in a young checkpoint is not_executed');
select is((select (x->>'changed_by_other')::boolean from jsonb_array_elements(:'c2'::jsonb->'resume'->'blocks') x
            where x->>'block_id' = (:'w1'::jsonb->'block_ids'->>0)), true,
          'a block a person edited after the checkpoint is changed_by_other');
select results_eq(format($q$ select body->>'from_harness', body->>'to_harness' from public.agent_activities where task_id = %L::uuid and type = 'handover' $q$, :'task'),
                  $q$ values ('claude_code'::text, 'codex'::text) $q$, 'one handover activity records from and to harness');
select is(:'c2'::jsonb->'resume'->'from'->>'delivered', 'false', 'a run that handed over is not a delivery');
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.claim_task(%L::uuid, %L, null, null, true)', :'task', 'codex')), 'run_active',
          'claiming again while the resumed run is active is run_active');
select tests.reset_role();
select is((select count(*)::int from public.agent_activities where task_id = :'task'::uuid and type = 'handover'), 1,
          'the refused claim adds no handover activity');

-- G. codex resumes task2: its last checkpoint is the ephemeral intent checkpoint of the cancelled run.
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task2'::uuid, 'codex', null, null, true) as c3 \gset
select tests.reset_role();
select ok((:'c3'::jsonb->'resume'->'checkpoint'->>'seq')::bigint = (select seq from public.agent_activities where id = :'cpt2'::uuid)
          and (select ephemeral from public.agent_activities where id = :'cpt2'::uuid)
          and (select run_id from public.agent_approvals where id = :'ap2'::uuid) = (:'c3'::jsonb->>'run_id')::uuid,
          'claim_task with resume returns the ephemeral intent checkpoint and rebinds the pending approval');
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.finish_external_op(%L::uuid, %L, %L)', :'op2', 'done', 'ts-1')), '',
          'an open external op of the old run is rebound and the new agent can finish it');

-- H. Readers and a first claim with resume.
select tests.reset_role();
select is(private.checkpoint_read('{"v":1,"next_step":"Minimal v1"}'::jsonb) -> 'checkpoint' -> 'ops' -> 'pending', '[]'::jsonb,
          'a v1 checkpoint missing optional lists reads with defaults');
select is((private.checkpoint_read('{"v":2,"next_step":"From the future","ops":{"pending":[{"key":"z"}]}}'::jsonb) ->> 'readable')::boolean, false,
          'a checkpoint with a newer version reads as unreadable');
select ok(private.task_waits_on_human(:'task'::uuid) and not private.task_waits_on_human(:'task3'::uuid),
          'task_waits_on_human is true only for a task with a pending approval');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A5', '{"objective":"Fresh task"}'::jsonb, (:'cx'::jsonb->>'agent')::uuid) ->> 'task_id' as task5 \gset
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task5'::uuid, 'codex', null, null, true) as c5 \gset
select tests.reset_role();
select ok(jsonb_typeof(:'c5'::jsonb->'resume'->'checkpoint') = 'null' and jsonb_typeof(:'c5'::jsonb->'resume'->'from') = 'null'
          and not exists (select 1 from public.agent_activities where task_id = :'task5'::uuid and type = 'handover'),
          'a first claim with resume has no checkpoint, no previous run and no handover activity');

-- I. The approval decided after the handover is used by the new run without a receipt.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap'::uuid, 'approve');
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.begin_external_op(:'run4'::uuid, 'smtp', 'send_email', '{"to":"team@example.com"}'::jsonb) as op4 \gset
select tests.reset_role();
select results_eq(format($q$ select a.status, o.approval_id from public.agent_approvals a, public.external_ops o
                            where a.id = %L::uuid and o.op_id = %L::uuid $q$, :'ap', :'op4'::jsonb->>'op_id'),
                  format($q$ values ('consumed'::text, %L::uuid) $q$, :'ap'),
                  'begin_external_op after a decided approval consumes it without a receipt');
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(public.begin_external_op(:'run4'::uuid, 'smtp', 'send_email', '{"to":"team@example.com"}'::jsonb) ->> 'op_id', :'op4'::jsonb->>'op_id',
          'a second begin_external_op with the same params returns the same op');

-- J. The capability can be declared at creation.
select tests.reset_role();
select ok(public.create_agent((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, tests.make_user('agent+new@agents.invalid'),
                              'New', 'acp_local', 'worker', null, '{"resume": true}'::jsonb) ->> 'agent_id' is not null,
          'create_agent accepts the resume capability');

-- K. A claim without resume still rebinds a pending approval and keeps its response shape.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A6', '{"objective":"Sixth task"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task6 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task6'::uuid, 'claude_code') ->> 'run_id' as run6 \gset
select public.request_approval(:'run6'::uuid, 'send_email', '{"to":"c@example.com"}'::jsonb, null, 'Send?') ->> 'approval_id' as ap6 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.release_for_handover(:'task6'::uuid, (:'cx'::jsonb->>'agent')::uuid, null) as rel6 \gset
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task6'::uuid, 'codex') as c6 \gset
select tests.reset_role();
select ok(not (:'c6'::jsonb ? 'resume') and (select run_id from public.agent_approvals where id = :'ap6'::uuid) = (:'c6'::jsonb->>'run_id')::uuid,
          'claim_task without resume has no resume key and still rebinds the pending approval');

-- L. A stop request wins over a handover: the run stays for ack_stop and the task is not queued again.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A7', '{"objective":"Seventh task"}'::jsonb, (:'cx'::jsonb->>'agent')::uuid) ->> 'task_id' as task7 \gset
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task7'::uuid, 'codex') ->> 'run_id' as run7 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'task7'::uuid, 'Stop, please', 'stop');
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.hand_over(%L::uuid, %L::jsonb, %L)', :'run7', '{"v":1,"next_step":"x","handover_note":"bye"}', 'ho-7')),
          'stop_requested', 'hand_over after a stop request is stop_requested');
select tests.reset_role();
select results_eq(format($q$ select r.status, t.state, t.active_run_id from public.agent_runs r, public.agent_tasks t
                            where r.id = %L::uuid and t.id = %L::uuid $q$, :'run7', :'task7'),
                  format($q$ values ('running'::text, 'working'::text, %L::uuid) $q$, :'run7'),
                  'the refused hand_over leaves the run active until the agent acknowledges the stop');

-- M. A run that saved no checkpoint makes the last checkpoint stale: gemini resumes after plain, which followed claude_code.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A8', '{"objective":"Eighth task"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task8 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task8'::uuid, 'claude_code', null, null, true) ->> 'run_id' as run8 \gset
select public.hand_over(:'run8'::uuid, '{"v":1,"next_step":"Append section 2","handover_note":"bye","ops":{"pending":[{"key":"k-s2","tool":"append_blocks","page_id":"page_A8"}]}}'::jsonb, 'ho-8');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.release_for_handover(:'task8'::uuid, (:'pl'::jsonb->>'agent')::uuid, null);
select tests.reset_role();
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select public.claim_task(:'task8'::uuid, 'plain') ->> 'run_id' as run8b \gset
select public.append_page_blocks('page_A8', '[{"type":"paragraph","spans":["Section 2"]}]'::jsonb, null, 'kb-1');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.release_for_handover(:'task8'::uuid, (:'gm'::jsonb->>'agent')::uuid, null);
select tests.reset_role();
select tests.set_agent((:'gm'::jsonb->>'user')::uuid, (:'gm'::jsonb->>'agent')::uuid);
select public.claim_task(:'task8'::uuid, 'gemini', null, null, true) as c8 \gset
select tests.reset_role();
select is(:'c8'::jsonb->'resume'->'from'->>'run_id', :'run8b', 'with a checkpoint older than the last run, from is the last run');
select ok(coalesce((:'c8'::jsonb->'resume'->'checkpoint'->>'stale')::boolean, false) and :'c8'::jsonb->'resume'->>'summary' like '%saved no checkpoint%',
          'a checkpoint older than the last run is flagged stale and the summary says why');
select is((select x->>'status' from jsonb_array_elements(:'c8'::jsonb->'resume'->'pending_ops') x where x->>'key' = 'k-s2'), 'unknown',
          'a pending write of a stale checkpoint without a receipt is unknown, not not_executed');
select results_eq(format($q$ select body->>'from_harness', body->>'to_harness' from public.agent_activities where task_id = %L::uuid and type = 'handover' $q$, :'task8'),
                  $q$ values ('plain'::text, 'gemini'::text) $q$, 'the handover activity names the last run as its origin');
select tests.set_agent((:'gm'::jsonb->>'user')::uuid, (:'gm'::jsonb->>'agent')::uuid);
select public.hand_over((:'c8'::jsonb->>'run_id')::uuid, '{"v":1,"next_step":"Review section 2","handover_note":"over to codex"}'::jsonb, 'ho-8c');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.release_for_handover(:'task8'::uuid, (:'cx'::jsonb->>'agent')::uuid, null);
select tests.reset_role();
select is((select body->>'from_run_id' from public.agent_activities where task_id = :'task8'::uuid and type = 'prompt' and body->>'source' = 'handover'
            order by seq desc limit 1), :'c8'::jsonb->>'run_id',
          'releasing an idle task names its last run as the origin, even when the runs started in one transaction');

-- N. The same agent claiming again after feedback is not a handover.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A9', '{"objective":"Ninth task"}'::jsonb, (:'cx'::jsonb->>'agent')::uuid) ->> 'task_id' as task9 \gset
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task9'::uuid, 'codex', null, null, true) ->> 'run_id' as run9 \gset
select public.add_artifact(:'run9'::uuid, 'page', 'page_A9', 'Result', '{}') ->> 'artifact_id' as art9 \gset
select public.submit_for_review(:'run9'::uuid, 'Done', array[:'art9'::uuid]);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.send_agent_message(:'task9'::uuid, 'Add the sources', 'feedback');
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task9'::uuid, 'codex', null, null, true) as c9 \gset
select tests.reset_role();
select ok(:'c9'::jsonb->'resume'->'from'->>'run_id' = :'run9'
          and not exists (select 1 from public.agent_activities where task_id = :'task9'::uuid and type = 'handover'),
          'a claim by the same agent after feedback adds no handover activity');
select is(:'c9'::jsonb->'resume'->'from'->>'delivered', 'true', 'a run that submitted for review is a delivery');

-- O. Automatic consumption takes only a decided approval for the same params with a live receipt.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A10', '{"objective":"Tenth task"}'::jsonb, (:'cx'::jsonb->>'agent')::uuid) ->> 'task_id' as task10 \gset
select tests.reset_role();
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select public.claim_task(:'task10'::uuid, 'codex') ->> 'run_id' as run10 \gset
select public.request_approval(:'run10'::uuid, 'send_email', '{"to":"p@example.com"}'::jsonb, null, 'Send?') ->> 'approval_id' as ap_p \gset
select public.request_approval(:'run10'::uuid, 'send_email', '{"to":"r@example.com"}'::jsonb, null, 'Send?') ->> 'approval_id' as ap_r \gset
select public.request_approval(:'run10'::uuid, 'send_email', '{"to":"e@example.com"}'::jsonb, null, 'Send?') ->> 'approval_id' as ap_e \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap_p'::uuid, 'approve');
select public.decide_approval(:'ap_r'::uuid, 'reject');
select public.decide_approval(:'ap_e'::uuid, 'approve');
select tests.reset_role();
update public.agent_approvals set receipt_expires_at = now() - interval '1 minute' where id = :'ap_e'::uuid;
select tests.set_agent((:'cx'::jsonb->>'user')::uuid, (:'cx'::jsonb->>'agent')::uuid);
select is(public.begin_external_op(:'run10'::uuid, 'smtp', 'send_email', '{"to":"other@example.com"}'::jsonb) ->> 'status', 'approval_required',
          'a decided approval for other params is not consumed');
select is(public.begin_external_op(:'run10'::uuid, 'smtp', 'send_email', '{"to":"r@example.com"}'::jsonb) ->> 'status', 'approval_required',
          'a rejected approval is not consumed');
select is(public.begin_external_op(:'run10'::uuid, 'smtp', 'send_email', '{"to":"e@example.com"}'::jsonb) ->> 'status', 'approval_required',
          'a decided approval whose receipt expired is not consumed');
select tests.reset_role();
select is((select count(*)::int from public.agent_approvals where id in (:'ap_p'::uuid, :'ap_r'::uuid, :'ap_e'::uuid) and status = 'decided'), 3,
          'the three decided approvals stay decided');

select * from finish();
rollback;
