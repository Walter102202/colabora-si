-- Metrics of how agents work for people: known numbers in, the same numbers out.
-- Nothing divides by zero, and a metric without a source says so instead of showing 0.
-- Two agents share T3 (the second one takes it over), so every per-agent filter changes at least one number.
begin;
select plan(55);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M2', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M3', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M4', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M5', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M6', 'page_A');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_M7', 'page_A');
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+idle@agents.invalid', 'worker', 'page_A') as idle \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+second@agents.invalid', 'worker', 'page_A') as second \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+hook@agents.invalid', 'worker', 'page_A') as hook \gset
update public.agents set kind = 'webhook' where id = (:'hook'::jsonb->>'agent')::uuid;
select tests.make_user('stranger@test.local') as stranger \gset
-- Everything happens in one transaction, where now() never moves: every timestamp is written explicitly.
select date_trunc('hour', now()) - interval '2 days' as t0 \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"One"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t1 \gset
select public.create_agent_task('page_M2', '{"objective":"Two"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t2 \gset
select public.create_agent_task('page_M3', '{"objective":"Three"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t3 \gset
select public.create_agent_task('page_M4', '{"objective":"Sub of one"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as s1 \gset
select public.create_agent_task('page_M5', '{"objective":"Idle"}'::jsonb, (:'idle'::jsonb->>'agent')::uuid) ->> 'task_id' as t4 \gset
select public.create_agent_task('page_B', '{"objective":"Not granted to the agent"}'::jsonb) ->> 'task_id' as hidden \gset
select public.create_agent_task('page_M6', '{"objective":"Led"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as p \gset
select tests.reset_role();
-- The Lead creates a subtask for the second agent: create_agent_task writes its start prompt as the Lead, without a
-- run, at the moment the subtask is created. That prompt is not a signal.
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.create_agent_task('page_M7', '{"objective":"Sub of the lead"}'::jsonb, (:'second'::jsonb->>'agent')::uuid, :'p'::uuid) ->> 'task_id' as s2 \gset
select tests.reset_role();
select created_at as n0 from public.agent_tasks where id = :'s2'::uuid \gset

create function pg_temp.act(p_task uuid, p_run uuid, p_type text, p_body jsonb, p_author text, p_at timestamptz)
returns void language sql as $$
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id, created_at)
  select t.workspace_id, t.id, p_run, private.next_seq(t.id), p_type, p_body, p_author,
         case p_author when 'human' then t.owner_user_id else coalesce((select r.agent_id from public.agent_runs r where r.id = p_run), t.delegate_agent_id) end,
         p_at
    from public.agent_tasks t where t.id = p_task;
$$;
create function pg_temp.run_of(p_task uuid) returns uuid language sql as $$
  select id from public.agent_runs where task_id = p_task order by started_at limit 1;
$$;
create function pg_temp.m(p jsonb, k text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p->'metrics') x where x->>'key' = k;
$$;

-- Runs of the agent, each with a reported cost: 0.50 + 0.40 + 0.30 + 0.60 = 1.80. T3's first run hands over and
-- ends at +1000 s; a run of the second agent claims T3 from the queue at +1300 s and reports 0.20.
-- The Lead's run on P and the second agent's run on S2 report nothing (cost_kind unknown, as with Claude Code or Codex).
insert into public.agent_runs (workspace_id, task_id, agent_id, harness, brief_version, status, cost_usd, cost_kind, started_at, ended_at)
select (:'f'::jsonb->>'ws')::uuid, v.id, v.agent, 'custom', 1, 'completed', v.cost, v.kind, v.started, v.ended
  from (values (:'t1'::uuid, (:'f'::jsonb->>'agent')::uuid, 0.50, 'measured', :'t0'::timestamptz, :'t0'::timestamptz + interval '1 hour'),
               (:'t2'::uuid, (:'f'::jsonb->>'agent')::uuid, 0.40, 'measured', :'t0'::timestamptz, :'t0'::timestamptz + interval '1 hour'),
               (:'t3'::uuid, (:'f'::jsonb->>'agent')::uuid, 0.30, 'estimated', :'t0'::timestamptz, :'t0'::timestamptz + interval '1000 seconds'),
               (:'s1'::uuid, (:'f'::jsonb->>'agent')::uuid, 0.60, 'measured', :'t0'::timestamptz, :'t0'::timestamptz + interval '1 hour'),
               (:'t3'::uuid, (:'second'::jsonb->>'agent')::uuid, 0.20, 'measured', :'t0'::timestamptz + interval '1300 seconds', :'t0'::timestamptz + interval '1 hour'),
               (:'p'::uuid, (:'lead'::jsonb->>'agent')::uuid, 0.00, 'unknown', :'n0'::timestamptz + interval '100 seconds', :'n0'::timestamptz + interval '1 hour'),
               (:'s2'::uuid, (:'second'::jsonb->>'agent')::uuid, 0.00, 'unknown', :'n0'::timestamptz + interval '600 seconds', :'n0'::timestamptz + interval '1 hour')
       ) as v(id, agent, cost, kind, started, ended);
select id as r3a from public.agent_runs where task_id = :'t3'::uuid and started_at = :'t0'::timestamptz \gset
select id as r3b from public.agent_runs where task_id = :'t3'::uuid and started_at > :'t0'::timestamptz \gset

-- Interventions by people: T1 2 (plus the closing note, left out), T2 1 (an answer; plus the subtask note, left out),
-- T3 3 (one is a release for handover: a person moving the task counts), S1 3 = 9.
-- The start prompts that create_agent_task wrote are left out too.
select pg_temp.act(:'t1'::uuid, null, 'prompt', '{"signal":"feedback","text":"a"}', 'human', :'t0'::timestamptz + interval '5 minutes');
select pg_temp.act(:'t1'::uuid, null, 'prompt', '{"signal":"feedback","text":"b"}', 'human', :'t0'::timestamptz + interval '6 minutes');
select pg_temp.act(:'t1'::uuid, null, 'prompt', '{"signal":"feedback","text":"ok","close":"accepted"}', 'human', :'t0'::timestamptz + interval '59 minutes');
select pg_temp.act(:'t2'::uuid, null, 'prompt', '{"signal":"feedback","approval_id":"x","decision":"respond","text":"c"}', 'human', :'t0'::timestamptz + interval '7 minutes');
select pg_temp.act(:'t2'::uuid, null, 'prompt', '{"signal":"feedback","subtask_id":"x","text":"Subtask closed"}', 'human', :'t0'::timestamptz + interval '8 minutes');
select pg_temp.act(:'t3'::uuid, null, 'prompt', '{"signal":"feedback","text":"d"}', 'human', :'t0'::timestamptz + interval '9 minutes');
select pg_temp.act(:'t3'::uuid, null, 'prompt', '{"signal":"continue","source":"handover","handover":true,"text":"e"}', 'human', :'t0'::timestamptz + interval '10 minutes');
select pg_temp.act(:'t3'::uuid, null, 'prompt', '{"signal":"stop","text":"f"}', 'human', :'t0'::timestamptz + interval '11 minutes');
select pg_temp.act(:'s1'::uuid, null, 'prompt', '{"signal":"feedback","text":"g"}', 'human', :'t0'::timestamptz + interval '12 minutes');
select pg_temp.act(:'s1'::uuid, null, 'prompt', '{"signal":"feedback","text":"h"}', 'human', :'t0'::timestamptz + interval '13 minutes');
select pg_temp.act(:'s1'::uuid, null, 'prompt', '{"signal":"feedback","text":"i"}', 'human', :'t0'::timestamptz + interval '14 minutes');

-- First signals are the claims, as claim_task writes them: T1 +100 s, T2 +200 s, T3 +300 s, S1 +200 s: median 200 s.
-- The metric measures how long a new task waits until an agent takes it.
select pg_temp.act(:'t1'::uuid, pg_temp.run_of(:'t1'::uuid), 'action', '{"op":"claim","harness":"custom"}', 'agent', :'t0'::timestamptz + interval '100 seconds');
select pg_temp.act(:'t2'::uuid, pg_temp.run_of(:'t2'::uuid), 'action', '{"op":"claim","harness":"custom"}', 'agent', :'t0'::timestamptz + interval '200 seconds');
select pg_temp.act(:'t3'::uuid, pg_temp.run_of(:'t3'::uuid), 'action', '{"op":"claim","harness":"custom"}', 'agent', :'t0'::timestamptz + interval '300 seconds');
select pg_temp.act(:'s1'::uuid, pg_temp.run_of(:'s1'::uuid), 'action', '{"op":"claim","harness":"custom"}', 'agent', :'t0'::timestamptz + interval '200 seconds');
-- P, the Lead's task, is claimed 100 s after it was created; S2, its subtask, 600 s after: median 350 s, not the 0 s
-- of the Lead's start prompt.
select pg_temp.act(:'p'::uuid, pg_temp.run_of(:'p'::uuid), 'action', '{"op":"claim","harness":"custom"}', 'agent', :'n0'::timestamptz + interval '100 seconds');
select pg_temp.act(:'s2'::uuid, pg_temp.run_of(:'s2'::uuid), 'action', '{"op":"claim","harness":"custom"}', 'agent', :'n0'::timestamptz + interval '600 seconds');

-- Reverts, written by a person as revert_run does: T1 before its acceptance (left out), T2 after it (counted).
-- An agent's action that says revert_run after T1's acceptance is not a revert by a person (left out).
select pg_temp.act(:'t1'::uuid, null, 'action', '{"op":"revert_run"}', 'human', :'t0'::timestamptz + interval '30 minutes');
select pg_temp.act(:'t2'::uuid, null, 'action', '{"op":"revert_run"}', 'human', :'t0'::timestamptz + interval '3 hours');
select pg_temp.act(:'t1'::uuid, pg_temp.run_of(:'t1'::uuid), 'action', '{"op":"revert_run"}', 'agent', :'t0'::timestamptz + interval '2 hours');

-- Handover on T3, in the order the handover writes it: the first run leaves its checkpoint and ends at +1000 s; the task
-- waits in the queue; the second agent's run claims it at +1300 s and, in the same transaction, claim_task writes the
-- handover activity that names the old run; its first thought comes at +1345 s. Resume time: 345 s, the queue
-- included; the claim and the handover activity are not work. T3 was new for the first agent only: the second agent's
-- claim is not a first signal.
select pg_temp.act(:'t3'::uuid, :'r3a'::uuid, 'checkpoint', '{"v":1,"handover":true,"next_step":"Finish","handover_note":"Halfway"}', 'agent', :'t0'::timestamptz + interval '1000 seconds');
select pg_temp.act(:'t3'::uuid, :'r3b'::uuid, 'action', '{"op":"claim","harness":"custom"}', 'agent', :'t0'::timestamptz + interval '1300 seconds');
select pg_temp.act(:'t3'::uuid, :'r3b'::uuid, 'handover',
                   jsonb_build_object('from_run_id', :'r3a', 'to_run_id', :'r3b', 'from_harness', 'custom', 'to_harness', 'custom'),
                   'agent', :'t0'::timestamptz + interval '1300 seconds');
select pg_temp.act(:'t3'::uuid, :'r3b'::uuid, 'thought', '{"text":"resuming"}', 'agent', :'t0'::timestamptz + interval '1345 seconds');

-- Decisions by people: 60 s, 90 s and 120 s; an automatic approval with 0 s must not count (median stays 90 s).
insert into public.agent_approvals (workspace_id, task_id, kind, action, action_hash, params, question, options, status, decision,
                                    requested_by_type, requested_by_id, decided_by, decided_at, created_at, auto_by)
values ((:'f'::jsonb->>'ws')::uuid, :'t1'::uuid, 'action', 'send_email', 'h1', '{}', '', array['approve','reject'], 'decided', 'approve',
        'agent', (:'f'::jsonb->>'agent')::uuid, (:'f'::jsonb->>'owner')::uuid, :'t0'::timestamptz + interval '11 minutes', :'t0'::timestamptz + interval '10 minutes', null),
       ((:'f'::jsonb->>'ws')::uuid, :'t2'::uuid, 'action', 'send_email', 'h2', '{}', '', array['approve','reject'], 'decided', 'approve',
        'agent', (:'f'::jsonb->>'agent')::uuid, (:'f'::jsonb->>'owner')::uuid, :'t0'::timestamptz + interval '21 minutes 30 seconds', :'t0'::timestamptz + interval '20 minutes', null),
       ((:'f'::jsonb->>'ws')::uuid, :'t3'::uuid, 'action', 'send_email', 'h3', '{}', '', array['approve','reject'], 'decided', 'reject',
        'agent', (:'f'::jsonb->>'agent')::uuid, (:'f'::jsonb->>'owner')::uuid, :'t0'::timestamptz + interval '32 minutes', :'t0'::timestamptz + interval '30 minutes', null),
       ((:'f'::jsonb->>'ws')::uuid, :'t2'::uuid, 'action', 'publish_page', 'h4', '{}', '', array['approve'], 'decided', 'approve',
        'system', (:'f'::jsonb->>'agent')::uuid, null, :'t0'::timestamptz + interval '40 minutes', :'t0'::timestamptz + interval '40 minutes', 'preset'),
       -- The second agent asks on T3 and a person decides in 30 s: it counts for the second agent only.
       ((:'f'::jsonb->>'ws')::uuid, :'t3'::uuid, 'action', 'send_email', 'h5', '{}', '', array['approve','reject'], 'decided', 'approve',
        'agent', (:'second'::jsonb->>'agent')::uuid, (:'f'::jsonb->>'owner')::uuid, :'t0'::timestamptz + interval '50 minutes 30 seconds', :'t0'::timestamptz + interval '50 minutes', null);

-- External effects that ran: one ran twice on T1. The failed one does not count.
insert into public.external_ops (workspace_id, task_id, run_id, provider, action, params_hash, params, idempotency_key, status)
values ((:'f'::jsonb->>'ws')::uuid, :'t1'::uuid, pg_temp.run_of(:'t1'::uuid), 'smtp', 'send_email', 'p1', '{}', 'k1', 'done'),
       ((:'f'::jsonb->>'ws')::uuid, :'t1'::uuid, pg_temp.run_of(:'t1'::uuid), 'smtp', 'send_email', 'p1', '{}', 'k2', 'done'),
       ((:'f'::jsonb->>'ws')::uuid, :'t1'::uuid, pg_temp.run_of(:'t1'::uuid), 'smtp', 'send_email', 'p2', '{}', 'k3', 'done'),
       ((:'f'::jsonb->>'ws')::uuid, :'t2'::uuid, pg_temp.run_of(:'t2'::uuid), 'web', 'publish_page', 'p3', '{}', 'k4', 'done'),
       ((:'f'::jsonb->>'ws')::uuid, :'t2'::uuid, pg_temp.run_of(:'t2'::uuid), 'web', 'publish_page', 'p3', '{}', 'k5', 'failed'),
       -- The second agent's run sends one email on T3: it is not the first agent's effect.
       ((:'f'::jsonb->>'ws')::uuid, :'t3'::uuid, :'r3b'::uuid, 'smtp', 'send_email', 'p9', '{}', 'k6', 'done');

-- States last, so no trigger on the inserts above can move them: T1, S1, T2 and S2 accepted; T3 and T4 failed.
-- P and S2 keep the moment they were created, which is when the Lead's start prompt was written.
update public.agent_tasks set created_at = :'t0'::timestamptz where id in (:'t1'::uuid, :'t2'::uuid, :'t3'::uuid, :'s1'::uuid, :'t4'::uuid);
update public.agent_tasks set parent_task_id = :'t1'::uuid where id = :'s1'::uuid;
update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = :'t0'::timestamptz + interval '1 hour' where id in (:'t1'::uuid, :'s1'::uuid);
update public.agent_tasks set state = 'done', acceptance = 'accepted', active_run_id = null, closed_at = :'n0'::timestamptz + interval '1 hour' where id = :'s2'::uuid;
update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = :'t0'::timestamptz + interval '2 hours' where id = :'t2'::uuid;
update public.agent_tasks set state = 'failed', active_run_id = null, closed_at = :'t0'::timestamptz + interval '3 hours' where id in (:'t3'::uuid, :'t4'::uuid);

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.agent_metrics((:'f'::jsonb->>'agent')::uuid) as am \gset
select public.agent_metrics((:'f'::jsonb->>'agent')::uuid, now() + interval '1 day') as later \gset
select public.agent_metrics((:'idle'::jsonb->>'agent')::uuid) as im \gset
select public.agent_metrics((:'second'::jsonb->>'agent')::uuid) as zm \gset
select public.agent_metrics((:'hook'::jsonb->>'agent')::uuid) as hm \gset
select public.task_metrics(:'t1'::uuid) as tm1 \gset
select public.task_metrics(:'t3'::uuid) as tm3 \gset
select public.task_metrics(:'p'::uuid) as tmp \gset
select tests.reset_role();

-- A. The agent's cohort and the ten metrics.
select is((select array_agg(x->>'key' order by o) from jsonb_array_elements(:'am'::jsonb->'metrics') with ordinality as e(x, o)),
          array['interventions_per_accepted','decision_latency_s','reverted_after_accept','time_to_first_signal_s','repeated_corrections',
                'resume_time_s','duplicate_effects','cost_per_accepted_usd','stale_knowledge_answers','out_of_scope_attempts'],
          'ten metrics in a fixed order');
select is((:'am'::jsonb->>'tasks')::int, 4, 'the cohort is every task delegated to the agent, failed ones included');
select is((pg_temp.m(:'am', 'interventions_per_accepted')->>'value')::numeric, 3::numeric, '9 interventions over 3 accepted deliverables');
select is((pg_temp.m(:'am', 'interventions_per_accepted')->>'sample')::int, 3, 'the sample is the accepted deliverables');
select is((pg_temp.m(:'am', 'decision_latency_s')->>'value')::numeric, 90::numeric,
          'median time to a decision by a person; the automatic one and the second agent''s are left out');
select is((pg_temp.m(:'am', 'decision_latency_s')->>'sample')::int, 3, 'three decisions by people');
select is((pg_temp.m(:'am', 'reverted_after_accept')->>'value')::numeric, 1::numeric, 'one task was reverted after its acceptance');
select is((pg_temp.m(:'am', 'time_to_first_signal_s')->>'value')::numeric, 200::numeric, 'median time to the first signal');
select is(pg_temp.m(:'am', 'resume_time_s')->>'status', 'no_data', 'the agent that handed over did not resume anything');
select is((pg_temp.m(:'am', 'duplicate_effects')->>'value')::numeric, 1::numeric, 'one external effect ran twice');
select is((pg_temp.m(:'am', 'duplicate_effects')->>'sample')::int, 4, 'out of four effects that ran; the second agent''s is not one of them');
select is((pg_temp.m(:'am', 'cost_per_accepted_usd')->>'value')::numeric, 0.6::numeric, '1.80 USD of its own runs over 3 accepted deliverables');
select is(pg_temp.m(:'am', 'cost_per_accepted_usd')->'reason', 'null'::jsonb, 'every run reported its cost: an exact number');
select is((pg_temp.m(:'am', 'repeated_corrections')->>'status') || ':' || (pg_temp.m(:'am', 'repeated_corrections')->>'reason'),
          'not_measured:needs_lessons', 'repeated corrections need a lessons log');
select is((pg_temp.m(:'am', 'stale_knowledge_answers')->>'status') || ':' || (pg_temp.m(:'am', 'stale_knowledge_answers')->>'reason'),
          'not_measured:needs_sources', 'stale answers need versioned sources');
select is(pg_temp.m(:'am', 'out_of_scope_attempts')->>'status', 'measured', 'with the denial log, the owner measures denied tool calls');

-- B. A task measures itself and its subtasks.
select is((:'tm1'::jsonb->>'tasks')::int, 2, 'a task counts its subtasks');
select is((pg_temp.m(:'tm1', 'interventions_per_accepted')->>'value')::numeric, 2.5::numeric, '5 interventions over 2 accepted deliverables');
select is(pg_temp.m(:'tm3', 'interventions_per_accepted')->>'status', 'no_data', 'a task without an accepted deliverable has no ratio');
select is(pg_temp.m(:'tm3', 'interventions_per_accepted')->'value', 'null'::jsonb, 'and its value is null, never 0 or an error');
select is((pg_temp.m(:'tm3', 'resume_time_s')->>'value')::numeric, 345::numeric, 'the task sees its own resume time');
select is(pg_temp.m(:'tm1', 'out_of_scope_attempts')->>'status' || ':' || (pg_temp.m(:'tm1', 'out_of_scope_attempts')->>'reason'),
          'not_measured:per_agent_only', 'most tools carry no task, so denied calls are counted per agent, never as 0 for a task');
select is((:'tmp'::jsonb->>'tasks')::int, 2, 'the Lead''s task counts the subtask it created');
select is((pg_temp.m(:'tmp', 'time_to_first_signal_s')->>'value')::numeric, 350::numeric,
          'claims at 100 s and 600 s: the start prompt the Lead wrote without a run is not a signal');
select is(pg_temp.m(:'tmp', 'cost_per_accepted_usd')->>'status' || ':' || (pg_temp.m(:'tmp', 'cost_per_accepted_usd')->>'reason'),
          'no_data:cost_unreported', 'no run reported a cost: there is no cost, never 0.00');
select is(pg_temp.m(:'tmp', 'cost_per_accepted_usd')->'value', 'null'::jsonb, 'and its value is null');

-- B2. The second agent took T3 over and did S2 for the Lead. Each number is its own.
select is((:'zm'::jsonb->>'tasks')::int, 2, 'the cohort of the second agent: the task it took over and its own');
select is((pg_temp.m(:'zm', 'time_to_first_signal_s')->>'value')::numeric, 600::numeric,
          'only S2 was new when it took it; T3 was taken first by the other agent');
select is((pg_temp.m(:'zm', 'time_to_first_signal_s')->>'sample')::int, 1, 'one task in the sample');
select is((pg_temp.m(:'zm', 'resume_time_s')->>'value')::numeric, 345::numeric,
          'resumed 345 s after the run that handed over ended, the queue included; the claim is not work');
select is((pg_temp.m(:'zm', 'decision_latency_s')->>'value')::numeric, 30::numeric, 'only the decision it asked for');
select is((pg_temp.m(:'zm', 'duplicate_effects')->>'value') || ' of ' || (pg_temp.m(:'zm', 'duplicate_effects')->>'sample'),
          '0 of 1', 'only the effect of its own run');
select is((pg_temp.m(:'zm', 'cost_per_accepted_usd')->>'value')::numeric, 0.2::numeric,
          'only its own reported cost, 0.20, over its 1 accepted deliverable');
select is(pg_temp.m(:'zm', 'cost_per_accepted_usd')->>'reason', 'cost_partial', 'its run on S2 reported nothing: the cost is a lower bound and says so');

-- C. No accepted deliverables, no window, no access.
select is(pg_temp.m(:'im', 'interventions_per_accepted')->>'status', 'no_data', 'an agent with zero accepted deliverables does not divide by zero');
select is(pg_temp.m(:'im', 'cost_per_accepted_usd')->>'status', 'no_data', 'nor shows a cost per deliverable');
select is((:'im'::jsonb->>'tasks')::int, 1, 'a task delegated to the agent counts in its cohort before the agent starts it');
select is(pg_temp.m(:'hm', 'out_of_scope_attempts')->>'status' || ':' || (pg_temp.m(:'hm', 'out_of_scope_attempts')->>'reason'),
          'not_measured:webhook_agent', 'a webhook agent calls through agent-webhook, which logs no denial: never 0');
select is((:'later'::jsonb->>'tasks')::int, 0, 'the window leaves out older tasks');
select ok((select bool_and(x->>'status' <> 'measured' and x->'value' = 'null'::jsonb) from jsonb_array_elements(:'later'::jsonb->'metrics') x),
          'an empty cohort has no measured metrics even with the denial log');
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.agent_metrics(%L::uuid)', :'f'::jsonb->>'agent')), 'not_found', 'a stranger cannot measure the agent');
select is(tests.error_of(format('select public.task_metrics(%L::uuid)', :'t1')), 'not_found', 'nor the task');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.task_metrics(%L::uuid)', :'t1')), 'not_found',
          'an agent gets no numbers, which would be partial: it only sees the approvals of its runs');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.agent_metrics(%L::uuid)', :'f'::jsonb->>'agent')), '42501', 'anon cannot call it');
select tests.reset_role();

-- D. Denied calls: agents report their own; the owner reads the count; nobody else sees it.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.record_access_denial('close_task', 'humans_only', :'t1'::uuid);
select public.record_access_denial('close_task', 'humans_only', :'t1'::uuid);
select public.record_access_denial('create_subtask', 'lead_only', null);
select is(tests.error_of('select public.record_access_denial(''close_task'', ''block_conflict'', null)'), 'invalid_input', 'only denial codes are recorded');
select is(tests.error_of('select public.record_access_denial(''Bad-tool'', ''forbidden'', null)'), 'invalid_input', 'tool names are constrained');
select is(public.record_access_denial('update_brief', 'direct_session_required', :'t1'::uuid)->>'recorded', 'true', 'direct session denials are access denials too');
select public.record_access_denial('edit_page', 'forbidden', :'hidden'::uuid);
select tests.reset_role();
select tests.set_agent((:'second'::jsonb->>'user')::uuid, (:'second'::jsonb->>'agent')::uuid);
select is(public.record_access_denial('edit_page', 'forbidden', null)->>'recorded', 'true', 'the same denial by another agent is its own');
select tests.reset_role();
select is((select target->'task_id' from public.audit_events where action = 'access.denied' and target->>'tool' = 'edit_page'
            and target->>'agent_id' = :'f'::jsonb->>'agent'), 'null'::jsonb, 'a task the agent cannot read is omitted from the log');
select is((select count(*)::int from public.audit_events where action = 'access.denied' and target->>'agent_id' = :'f'::jsonb->>'agent'), 4,
          'a repeated denial within a minute is recorded once');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of('select public.record_access_denial(''close_task'', ''forbidden'', null)'), 'forbidden', 'a person cannot write denials');
select public.agent_metrics((:'f'::jsonb->>'agent')::uuid) as am2 \gset
select public.agent_metrics((:'second'::jsonb->>'agent')::uuid) as zm2 \gset
select tests.reset_role();
select is((pg_temp.m(:'am2', 'out_of_scope_attempts')->>'value')::int, 4, 'the owner sees four denied tool calls of the agent');
select is((pg_temp.m(:'zm2', 'out_of_scope_attempts')->>'value')::int, 1, 'and one of the second agent');
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select public.agent_metrics((:'f'::jsonb->>'agent')::uuid) as vm \gset
select tests.reset_role();
select is(pg_temp.m(:'vm', 'out_of_scope_attempts')->>'reason', 'owners_only', 'anyone else is told that only owners see it');
select tests.set_anon();
select is(tests.sqlstate_of('select public.record_access_denial(''close_task'', ''forbidden'', null)'), '42501', 'anon cannot record a denial');
select tests.reset_role();

select * from finish();
rollback;
