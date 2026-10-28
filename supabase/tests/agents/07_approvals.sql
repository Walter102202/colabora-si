begin;
select plan(13);

select tests.fixture() as f \gset

select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Email the summary"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset
select public.request_approval(:'run'::uuid, 'send_email', '{"to":"team@example.com"}'::jsonb, null, 'Send the summary?') ->> 'approval_id' as ap1 \gset

select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L)', :'ap1', 'approve')), 'humans_only', 'an agent cannot decide an approval');

select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1');
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L)', :'ap1', 'approve')), 'direct_session_required', 'an OAuth session cannot decide an approval');
-- Irreversible: edit from an OAuth session is refused like approve.
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L, %L::jsonb)', :'ap1', 'edit', '{"params":{"to":"x@example.com"}}')), 'direct_session_required', 'an OAuth session cannot edit-approve an action');

-- Decisions that execute nothing may come from a chat: a question, a go-ahead on a question, a rejection.
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_input(:'run'::uuid, 'Which tone?') ->> 'approval_id' as q1 \gset
select public.request_input(:'run'::uuid, 'Go ahead with the draft?', array['respond','approve','ignore']) ->> 'approval_id' as q2 \gset
select public.request_approval(:'run'::uuid, 'send_email', '{"to":"r@example.com"}'::jsonb) ->> 'approval_id' as ap0 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'mcp-client-1');
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L, %L::jsonb)', :'q1', 'respond', '{"text":"Formal"}')), '', 'an OAuth session may answer a question');
select public.decide_approval(:'q2'::uuid, 'approve') as q2res \gset
select is(:'q2res'::jsonb ->> 'receipt', null, 'a go-ahead on a question is accepted from an OAuth session and mints no receipt');
select is(tests.error_of(format('select public.decide_approval(%L::uuid, %L)', :'ap0', 'reject')), '', 'an OAuth session may reject an action');

select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap1'::uuid, 'approve') ->> 'receipt' as r1 \gset
select ok(:'r1' is not null, 'approve returns a receipt');

select tests.reset_role();
select is(private.consume_approval(:'r1'::uuid, 'send_email', '{"to":"team@example.com"}'::jsonb, null, 'test'), :'ap1'::uuid, 'the receipt is consumed once');
select is(tests.error_of(format('select private.consume_approval(%L::uuid, %L, %L::jsonb, null, %L)', :'r1', 'send_email', '{"to":"team@example.com"}', 'test')),
          'approval_consumed', 'a consumed receipt cannot be reused');

-- Different parameters than the approved ones.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_approval(:'run'::uuid, 'send_email', '{"to":"ceo@example.com"}'::jsonb) ->> 'approval_id' as ap2 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap2'::uuid, 'approve') ->> 'receipt' as r2 \gset
select tests.reset_role();
select is(tests.error_of(format('select private.consume_approval(%L::uuid, %L, %L::jsonb, null, %L)', :'r2', 'send_email', '{"to":"all@example.com"}', 'test')),
          'approval_mismatch', 'executing different parameters is rejected');

-- Expired receipt.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_approval(:'run'::uuid, 'send_email', '{"to":"ops@example.com"}'::jsonb) ->> 'approval_id' as ap3 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap3'::uuid, 'approve') ->> 'receipt' as r3 \gset
select tests.reset_role();
update public.agent_approvals set receipt_expires_at = now() - interval '1 minute' where id = :'ap3'::uuid;
select is(tests.error_of(format('select private.consume_approval(%L::uuid, %L, %L::jsonb, null, %L)', :'r3', 'send_email', '{"to":"ops@example.com"}', 'test')),
          'receipt_expired', 'an expired receipt is rejected');

-- Edit replaces the parameters and the hash covers the edited ones.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.request_approval(:'run'::uuid, 'send_email', '{"to":"x@example.com"}'::jsonb) ->> 'approval_id' as ap4 \gset
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.decide_approval(:'ap4'::uuid, 'edit', '{"params":{"to":"y@example.com"}}'::jsonb) ->> 'receipt' as r4 \gset
select tests.reset_role();
select is((select action_hash from public.agent_approvals where id = :'ap4'::uuid),
          private.action_hash('send_email', :'task'::uuid, null, '{"to":"y@example.com"}'::jsonb), 'edit recomputes the action hash');
select is(private.consume_approval(:'r4'::uuid, 'send_email', '{"to":"y@example.com"}'::jsonb, null, 'test'), :'ap4'::uuid, 'the edited parameters are what the receipt authorizes');

select * from finish();
rollback;
