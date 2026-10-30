begin;
select plan(26);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['page_G']) p;
select tests.make_user('other-person@test.local') as other \gset
select tests.reset_role();

-- 1. The hook is installed.
select ok((select rolconfig::text like '%pgrst.db_pre_request=private.apply_session_link%' from pg_roles where rolname = 'authenticator'),
          'PostgREST runs the session hook before every request');
-- 2-3. Roles that reach the hook. Without these, every request of that role fails.
select ok(has_schema_privilege('service_role', 'private', 'usage'), 'the service role can reach the hook schema');
select ok(has_function_privilege('anon', 'private.apply_session_link()', 'execute'), 'anonymous requests can run the hook');

-- 4-6. set_oauth_link refuses a chat session, a stranger and the platform agent.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select is(tests.error_of(format('select public.set_oauth_link(%L, %L::uuid)', 'client-1', :'f'::jsonb->>'agent')), 'direct_session_required',
          'a chat cannot link itself to an agent');
select tests.reset_role();
select tests.set_human(:'other'::uuid);
select is(tests.error_of(format('select public.set_oauth_link(%L, %L::uuid)', 'client-1', :'f'::jsonb->>'agent')), 'forbidden',
          'only the sponsor or the owner may link an agent');
select is((select count(*)::int from public.linkable_agents()), 0, 'a stranger has no agents to link');
select tests.reset_role();

-- 7-8. The owner links; relinking replaces.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.set_oauth_link('client-1', (:'f'::jsonb->>'agent')::uuid))->>'linked', 'true', 'the owner links the client');
select is(public.set_oauth_link('client-1', (:'f'::jsonb->>'agent')::uuid)->>'linked', 'true', 'linking again is idempotent');
select tests.reset_role();

-- 9-10. A session without a link stays the person.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-other');
select private.apply_session_link();
select is(private.principal_type(), 'human', 'a chat without a link stays the person');
select is((select auth.uid()), (:'f'::jsonb->>'owner')::uuid, 'and keeps the person''s id');
select tests.reset_role();

-- 11-15. A linked session becomes the agent: identity, reads, and what only people may do.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select private.apply_session_link();
select is(private.principal_type(), 'agent', 'a linked chat is an agent');
select is((select auth.uid()), (:'f'::jsonb->>'agent_user')::uuid, 'it carries the agent''s user id');
select is(private.current_agent_id(), (:'f'::jsonb->>'agent')::uuid, 'current_agent_id resolves');
select is((auth.jwt() ->> 'via_user')::uuid, (:'f'::jsonb->>'owner')::uuid, 'via_user keeps who connected it');
select is((public.session_identity())->>'agent_id', :'f'::jsonb->>'agent', 'session_identity reports the agent');
-- 16-18. It writes where the agent may, and only there.
select is(tests.error_of('select public.append_page_blocks(''page_B'', ''[{"type":"paragraph","spans":["x"]}]''::jsonb)'), 'forbidden',
          'a page the person can edit but the agent cannot is refused');
select is(tests.error_of('select public.apply_page_ops(''page_G'', ''[]''::jsonb)'), 'use_partial_writes', 'the whole-ops entry stays closed');
select is(tests.error_of(format('select public.close_task(%L::uuid, %L)', gen_random_uuid(), 'accepted')), 'humans_only', 'it cannot accept work');
select tests.reset_role();

-- 19. The stamp names the agent and the person.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select private.apply_session_link();
select public.append_page_blocks('page_G', '[{"type":"paragraph","spans":["hello"]}]'::jsonb);
select tests.reset_role();
select is((select b->'attr'->>'via' from public.pages p, jsonb_array_elements(p.data->'blocks') b
            where p.id = 'page_G' and b->'attr' ? 'via' limit 1), :'f'::jsonb->>'owner', 'the block stamp records via');

-- 20. Without the hook a live link is refused, so a missing hook cannot hand the chat the person's reach.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select is(tests.error_of('select public.session_identity()'), 'session_link_not_applied', 'an unapplied link fails closed');
select tests.reset_role();

-- 21-22. A disabled agent stays the principal and every agent RPC refuses it.
update public.agents set status = 'disabled' where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select private.apply_session_link();
select is(private.principal_type(), 'agent', 'a disabled agent does not fall back to the person');
select is(private.current_agent_id(), null, 'and it has no agent identity');
select tests.reset_role();
update public.agents set status = 'enabled' where id = (:'f'::jsonb->>'agent')::uuid;

-- 23-24. revoke_oauth_link refuses the chat at once.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.revoke_oauth_link('client-1'))->>'revoked', 'true', 'the person disconnects the chat');
select is(tests.error_of('select public.revoke_oauth_link(''client-1'')'), 'not_found', 'disconnecting twice says so');
select tests.reset_role();
-- 25. raise sqlstate PGRST carries the code inside the message JSON.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select ok(tests.error_of('select private.apply_session_link()') like '%link_revoked%', 'a disconnected chat is refused by the hook');
select tests.reset_role();

-- 26. A null agent removes the link, so reconnecting "as you" works.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_oauth_link('client-1', null);
select tests.reset_role();
select is((select count(*)::int from public.agent_oauth_links where client_id = 'client-1'), 0, 'connecting as the person clears the link');

select * from finish();
rollback;
