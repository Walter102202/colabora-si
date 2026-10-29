-- Autonomy presets over preapproved: three workspace levels, a per-task level that only the owner sets and that never
-- exceeds the parent, a workspace at ask that caps every task, recorded automatic approvals, and questions and
-- payments that always reach a person.
begin;
select plan(56);

select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A')
  from unnest(array['page_A2','page_A3','page_A4','page_A5','page_A6','page_A7','page_A8']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_user('editor@test.local') as editor \gset
select tests.make_user('stranger@test.local') as stranger \gset
insert into public.workspace_members (workspace_id, user_id, role) values ((:'f'::jsonb->>'ws')::uuid, :'editor'::uuid, 'editor');

-- A. The workspace level: its owner sets it from the app; everyone else is refused.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.get_autonomy_policy((:'f'::jsonb->>'ws')::uuid) ->> 'level', 'ask', 'a workspace starts at ask');
select is((public.get_autonomy_policy((:'f'::jsonb->>'ws')::uuid) ->> 'can_edit')::boolean, true, 'its owner may change it');
select tests.reset_role();
select tests.set_human(:'editor'::uuid);
select is(tests.error_of(format('select public.set_workspace_autonomy(%L::uuid, %L)', :'f'::jsonb->>'ws', 'balanced')), 'owner_required',
          'an editor cannot change the level');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1');
select is(tests.error_of(format('select public.set_workspace_autonomy(%L::uuid, %L)', :'f'::jsonb->>'ws', 'autonomous')), 'direct_session_required',
          'a chat session cannot change the level');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.set_workspace_autonomy(%L::uuid, %L)', :'f'::jsonb->>'ws', 'autonomous')), 'humans_only',
          'an agent cannot change the level');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.set_workspace_autonomy(%L::uuid, %L)', :'f'::jsonb->>'ws', 'reckless')), 'invalid_input',
          'an unknown level is invalid_input');
select tests.reset_role();
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.get_autonomy_policy(%L::uuid)', :'f'::jsonb->>'ws')), 'forbidden',
          'someone outside the workspace cannot read the level');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'balanced');
select tests.reset_role();
select is((select autonomy from public.agent_workspace_policies where workspace_id = (:'f'::jsonb->>'ws')::uuid), 'balanced',
          'the owner sets balanced');
select ok(exists (select 1 from public.audit_events where workspace_id = (:'f'::jsonb->>'ws')::uuid
                   and action = 'autonomy.set' and target->>'to' = 'balanced'), 'the change is audited');

-- B. balanced approves publish_page on its own and records it like a decision.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Publish the summary"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t1 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t1'::uuid, 'custom') ->> 'run_id' as r1 \gset
select public.request_approval(:'r1'::uuid, 'publish_page', '{"page_id":"page_A1"}'::jsonb, null, 'Publish it?') as a1 \gset
select is(:'a1'::jsonb ->> 'status', 'approved', 'balanced approves publish_page at once');
select ok((:'a1'::jsonb ->> 'receipt') is not null, 'the automatic approval carries a receipt');
select tests.reset_role();
select is((select auto_by from public.agent_approvals where id = (:'a1'::jsonb->>'approval_id')::uuid), 'preset', 'the approval row records why');
select is((select decided_by::text from public.agent_approvals where id = (:'a1'::jsonb->>'approval_id')::uuid), null::text, 'no person decided it');
select is((select state from public.agent_tasks where id = :'t1'::uuid), 'working', 'the task did not stop');
select ok(exists (select 1 from public.agent_activities where task_id = :'t1'::uuid and type = 'action'
                   and body->>'op' = 'auto_approval' and body->>'by' = 'preset'), 'an activity shows the automatic approval');
select ok(exists (select 1 from public.audit_events where action = 'approval.auto'
                   and target->>'approval_id' = :'a1'::jsonb->>'approval_id'), 'the automatic approval is audited');
select is((select count(*)::int from public.notifications where task_id = :'t1'::uuid and kind = 'approval_requested'), 0,
          'nobody is notified of an automatic approval');

-- C. What the level does not cover still asks; require_approval in the brief beats the preset.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_approval(:'r1'::uuid, 'send_email', '{"to":"a@b.test"}'::jsonb) as mail \gset
select is(:'mail'::jsonb ->> 'status', 'pending', 'balanced still asks before send_email');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A2', '{"objective":"Publish carefully","policies":{"require_approval":["publish_page"]}}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t2 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t2'::uuid, 'custom') ->> 'run_id' as r2 \gset
select is(public.request_approval(:'r2'::uuid, 'publish_page', '{"page_id":"page_A2"}'::jsonb) ->> 'status', 'pending',
          'require_approval in the brief beats the preset');
select is(public.begin_external_op(:'r2'::uuid, 'web', 'publish_page', '{"page_id":"page_A2"}'::jsonb) ->> 'status', 'approval_required',
          'begin_external_op asks too');

-- D. begin_external_op records what the level allowed and reuses what request_approval already granted.
select public.begin_external_op(:'r1'::uuid, 'web', 'publish_page', '{"page_id":"page_A"}'::jsonb) ->> 'op_id' as op1 \gset
select public.begin_external_op(:'r1'::uuid, 'web', 'publish_page', '{"page_id":"page_A1"}'::jsonb) ->> 'op_id' as op2 \gset
select tests.reset_role();
select ok((select approval_id from public.external_ops where op_id = :'op1'::uuid) is not null,
          'an external op the preset allowed points at its approval');
select is((select a.status from public.agent_approvals a join public.external_ops o on o.approval_id = a.id where o.op_id = :'op1'::uuid),
          'consumed', 'that approval is consumed');
select is((select approval_id::text from public.external_ops where op_id = :'op2'::uuid), :'a1'::jsonb->>'approval_id',
          'begin_external_op consumes the approval request_approval already granted');

-- E. A higher level settles a request still waiting on a person; a task level lives apart from the brief;
--    a subtask never gets more than its parent.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'autonomous');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'r1'::uuid, 'send_email', '{"to":"a@b.test"}'::jsonb) ->> 'status', 'approved',
          'asked again under autonomous, send_email is approved on its own');
select tests.reset_role();
select is((select status from public.agent_approvals where id = (:'mail'::jsonb->>'approval_id')::uuid), 'cancelled',
          'the request for the same action that waited on a person is cancelled');
select is((select state from public.agent_tasks where id = :'t1'::uuid), 'working', 'and the task resumes');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A3', '{"objective":"Run the campaign"}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select public.set_task_autonomy(:'parent'::uuid, 'balanced') ->> 'level' as parent_level \gset
select tests.reset_role();
select is(:'parent_level'::text, 'balanced', 'the owner sets one task to balanced under an autonomous workspace');
select is((select brief_version from public.agent_tasks where id = :'parent'::uuid), 1, 'setting a task level does not version the brief');
select ok(exists (select 1 from public.audit_events where action = 'autonomy.task_set'
                   and target->>'task_id' = :'parent' and target->>'to' = 'balanced'), 'the task level change is audited');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_A4', '{"objective":"Send the emails","policies":{"preapproved":["send_email"]}}'::jsonb,
                             (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset
select is(tests.error_of(format('select public.set_task_autonomy(%L::uuid, %L)', :'sub', 'autonomous')), 'humans_only',
          'a Lead cannot raise the level of its subtask');
select is(public.task_autonomy(:'sub'::uuid) ->> 'level', 'balanced', 'a subtask under a balanced parent stays balanced');
select is(public.task_autonomy(:'sub'::uuid) ->> 'source', 'parent', 'and says the parent limits it');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'custom') ->> 'run_id' as sr \gset
select is(public.request_approval(:'sr'::uuid, 'send_email', '{"to":"list@b.test"}'::jsonb) ->> 'status', 'pending',
          'a Lead cannot preapprove for a subtask what the parent would ask');
select is(public.request_approval(:'sr'::uuid, 'publish_page', '{"page_id":"page_A4"}'::jsonb) ->> 'status', 'approved',
          'what the parent allows, the subtask may do');
select tests.reset_role();

-- F. Above the workspace only by its owner from the app. A preapproval counts only if a person wrote that list
--    from the app; a chat session reaches it only by calling the RPC directly, since create_task takes no policies
--    and no tool edits a brief, so this is defense in depth.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'balanced');
select public.create_agent_task('page_A5', '{"objective":"Email the board"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t5 \gset
select public.set_task_autonomy(:'t5'::uuid, 'autonomous');
select is(public.task_autonomy(:'t5'::uuid) ->> 'level', 'autonomous', 'the owner may raise one task above the workspace');
select is(public.task_autonomy(:'t5'::uuid) ->> 'source', 'task', 'and the task says so');
select tests.reset_role();
select tests.set_human(:'editor'::uuid);
select is(tests.error_of(format('select public.set_task_autonomy(%L::uuid, %L)', :'t5', 'ask')), 'owner_required',
          'an editor cannot set a task level');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1');
select is(tests.error_of(format('select public.set_task_autonomy(%L::uuid, %L)', :'t5', 'autonomous')), 'direct_session_required',
          'a chat session cannot set a task level');
select public.create_agent_task('page_A7', '{"objective":"Email the press","policies":{"preapproved":["send_email"]}}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t7 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.set_task_autonomy(%L::uuid, %L)', :'t5', 'reckless')), 'invalid_input',
          'an unknown task level is invalid_input');
select public.create_agent_task('page_A8', '{"objective":"Email the summary","policies":{"preapproved":["send_email"]}}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t8 \gset
select public.create_agent_task('page_A6', '{"objective":"Pay the invoice","policies":{"preapproved":["payment"]}}'::jsonb,
                                (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t9 \gset
-- The owner edits the chat brief from the app without touching its preapprovals.
select public.update_brief(:'t7'::uuid, '{"next_step":"Draft the press note"}'::jsonb);
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t7'::uuid, 'custom') ->> 'run_id' as r7 \gset
select is(public.request_approval(:'r7'::uuid, 'send_email', '{"to":"press@b.test"}'::jsonb) ->> 'status', 'pending',
          'a preapproval written from a chat session does not count, even after the owner edits other fields');
select public.claim_task(:'t8'::uuid, 'custom') ->> 'run_id' as r8 \gset
select public.request_approval(:'r8'::uuid, 'send_email', '{"to":"x@b.test"}'::jsonb) as a8 \gset
select is(:'a8'::jsonb ->> 'status', 'approved', 'a preapproval written in the app holds');
select public.update_brief(:'t8'::uuid, '{"next_step":"Send the second batch"}'::jsonb);
select is(public.request_approval(:'r8'::uuid, 'send_email', '{"to":"y@b.test"}'::jsonb) ->> 'status', 'approved',
          'the delegate updating its next step keeps the preapproval');
select public.claim_task(:'t9'::uuid, 'custom') ->> 'run_id' as r9 \gset
select is(public.request_approval(:'r9'::uuid, 'payment', '{"amount":10}'::jsonb) ->> 'status', 'pending',
          'a preapproved payment still asks');
select tests.reset_role();
select is((select auto_by from public.agent_approvals where id = (:'a8'::jsonb->>'approval_id')::uuid), 'brief',
          'the preapproval is recorded as coming from the brief');
select is((select preapproved_trusted from public.task_briefs where task_id = :'t7'::uuid and version = 2), false,
          'the new version of the chat brief is still not trusted');

-- G. Autonomy never answers a question; web requests and payments ask even when autonomous.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t5'::uuid, 'custom') ->> 'run_id' as r5 \gset
select public.request_approval(:'r5'::uuid, 'send_email', '{"to":"board@b.test"}'::jsonb) as a5 \gset
select is(:'a5'::jsonb ->> 'status', 'approved', 'a task raised to autonomous sends email without asking');
select public.request_input(:'r5'::uuid, 'Which board members?') ->> 'approval_id' as q5 \gset
select tests.reset_role();
select is((select status from public.agent_approvals where id = :'q5'::uuid), 'pending', 'autonomy never answers a question');
select is((select state from public.agent_tasks where id = :'t5'::uuid), 'input_required', 'and the question still blocks by default');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'r5'::uuid, 'payment', '{"amount":10}'::jsonb) ->> 'status', 'pending',
          'payment always asks, even when autonomous');
select is(public.request_approval(:'r5'::uuid, 'http_request', '{"url":"https://api.example/charge"}'::jsonb) ->> 'status', 'pending',
          'a web request asks, even when autonomous, unless the brief preapproves it');
select tests.reset_role();

-- H. A workspace at ask caps every task, even one its owner raised, and an automatic approval stops counting.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'ask');
select is(public.task_autonomy(:'t5'::uuid) ->> 'level', 'ask', 'a workspace at ask caps even a task its owner raised');
select is(public.task_autonomy(:'t5'::uuid) ->> 'source', 'workspace', 'and says the workspace limits it');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.begin_external_op(:'r5'::uuid, 'smtp', 'send_email', '{"to":"board@b.test"}'::jsonb) ->> 'status', 'approval_required',
          'the automatic approval granted before no longer counts: a person decides');
select is(public.begin_external_op(:'r5'::uuid, 'smtp', 'send_email', '{"to":"board@b.test"}'::jsonb, (:'a5'::jsonb->>'receipt')::uuid) ->> 'status',
          'approval_required', 'not even with its receipt');
select tests.reset_role();

-- I. Reading or setting a task level needs access to the task.
select tests.set_human(:'stranger'::uuid);
select is(tests.error_of(format('select public.task_autonomy(%L::uuid)', :'t1')), 'not_found', 'a stranger cannot read a task autonomy');
select is(tests.error_of(format('select public.set_task_autonomy(%L::uuid, %L)', :'t1', 'ask')), 'not_found', 'nor set it');
select tests.reset_role();

select * from finish();
rollback;
