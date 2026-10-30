begin;
select plan(57);
create or replace function tests.set_oauth_agent(p_uid uuid, p_agent uuid, p_client text)
returns void language sql as $$
  select tests.set_claims(jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aud', 'authenticated',
    'client_id', p_client, 'app_metadata', jsonb_build_object('principal_type', 'agent', 'agent_id', p_agent)), 'authenticated');
$$;
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
select is(tests.error_of(format('select public.issue_agent_token(%L::uuid)', :'f'::jsonb->>'agent')), 'direct_session_required',
          'a human OAuth chat cannot mint a persistent agent token');
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

-- An explicitly authorized As-you session stays the person.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_oauth_link('client-other', null);
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-other');
select private.apply_session_link();
select is(private.principal_type(), 'human', 'an explicit human link stays the person');
select is((select auth.uid()), (:'f'::jsonb->>'owner')::uuid, 'and keeps the person''s id');
select tests.reset_role();

-- A legacy human-subject token must not be converted into an agent.
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-1');
select ok(tests.error_of('select private.apply_session_link()') like '%link_revoked%', 'a human-subject token cannot use an agent link');
select tests.reset_role();

-- A linked session already is the agent: the hook only validates and stamps it.
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'client-1');
select is(private.current_agent_id(), (:'f'::jsonb->>'agent')::uuid, 'a live OAuth link resolves without the PostgREST hook');
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
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'client-1');
select private.apply_session_link();
select public.append_page_blocks('page_G', '[{"type":"paragraph","spans":["hello"]}]'::jsonb);
select tests.reset_role();
select is((select b->'attr'->>'via' from public.pages p, jsonb_array_elements(p.data->'blocks') b
            where p.id = 'page_G' and b->'attr' ? 'via' limit 1), :'f'::jsonb->>'owner', 'the block stamp records via');

-- 20. Without the hook a live link is refused, so a missing hook cannot hand the chat the person's reach.
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'client-1');
select is(tests.error_of('select public.session_identity()'), 'session_link_not_applied', 'an unapplied link fails closed');
select tests.reset_role();
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'hidden-client');
select is(private.current_agent_id(), null::uuid, 'a second client without a link has no agent identity outside PostgREST');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(private.current_agent_id(), (:'f'::jsonb->>'agent')::uuid, 'a direct agent token needs no OAuth link');
select tests.reset_role();

-- 21-22. A disabled agent stays the principal and every agent RPC refuses it.
update public.agents set status = 'disabled' where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'client-1');
select is(tests.error_of('select public.session_identity()'), 'session_link_not_applied', 'a disabled link also fails closed without the hook');
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
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'client-1');
select is(private.current_agent_id(), null::uuid, 'Disconnect removes the agent identity outside PostgREST');
select ok(tests.error_of('select public.session_identity()') like '%link_revoked%', 'a revoked link is refused even without the hook');
select ok(tests.error_of('select private.apply_session_link()') like '%link_revoked%', 'a disconnected chat is refused by the hook');
select tests.reset_role();

-- A null agent writes an explicit human link.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_oauth_link('client-1', null);
select tests.reset_role();
select is((select count(*)::int from public.agent_oauth_links where client_id = 'client-1' and agent_id is null), 1, 'connecting as the person keeps an explicit human link');
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'unknown-client');
select ok(tests.error_of('select private.apply_session_link()') like '%link_revoked%', 'a client without an explicit link is denied');
select ok(tests.error_of('select public.session_identity()') like '%link_revoked%', 'an unknown client also fails closed without the hook');
select tests.reset_role();

-- The sponsor must still belong to the workspace, both when linking and on every request.
select tests.reset_role();
update public.agents set sponsor_user_id = (:'f'::jsonb->>'viewer')::uuid where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select public.set_oauth_link('former-member', (:'f'::jsonb->>'agent')::uuid);
select public.issue_agent_token((:'f'::jsonb->>'agent')::uuid)->>'token_id' as member_token \gset
select tests.reset_role();
delete from public.workspace_members where workspace_id = (:'f'::jsonb->>'ws')::uuid and user_id = (:'f'::jsonb->>'viewer')::uuid;
select token_hash as member_hash from public.agent_tokens where id = :'member_token'::uuid \gset
select tests.set_service();
select is(public.lookup_agent_token(:'member_hash'), null::jsonb, 'a PAT issued by a former member cannot be exchanged');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select count(*)::int from public.linkable_agents()), 0, 'a former-member sponsor has no linkable agents');
select is(tests.error_of(format('select public.set_oauth_link(%L, %L::uuid)', 'new-link', :'f'::jsonb->>'agent')), 'forbidden', 'a former member cannot create a link');
select is(tests.error_of(format('select public.issue_agent_token(%L::uuid)', :'f'::jsonb->>'agent')), 'forbidden', 'a former member cannot issue a PAT');
select is(tests.error_of(format('select public.update_agent(%L::uuid, %L::jsonb)', :'f'::jsonb->>'agent', '{"name":"Hijacked"}')), 'forbidden', 'a former-member sponsor cannot manage the agent');
select is(tests.error_of(format('select public.revoke_agent_token(%L::uuid)', :'member_token')), 'forbidden', 'a former-member sponsor cannot manage its tokens');
select tests.reset_role();
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'former-member');
select is(private.current_agent_id(), null::uuid, 'a former member has no agent identity outside PostgREST');
select ok(tests.error_of('select private.apply_session_link()') like '%link_revoked%', 'an existing link stops when its person leaves the workspace');
select tests.reset_role();

-- Agent OAuth helpers authorize the direct person, not the chat or a stranger.
select tests.set_human(:'other'::uuid);
select is(tests.error_of(format('select public.oauth_agent_context(%L::uuid)', :'f'::jsonb->>'agent')), 'forbidden', 'a stranger cannot obtain an OAuth agent context');
select is(tests.sqlstate_of(format('select public.oauth_authorization_context(%L, %L::uuid)', 'authz', :'f'::jsonb->>'agent_user')), '42501', 'only the server reads Auth authorization metadata');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'client-other');
select is(tests.error_of(format('select public.set_oauth_app(%L, null, %L, %L)', 'x', 'App', 'https://claude.ai/cb')), 'direct_session_required', 'a chat cannot register its own app link');
select is(tests.error_of('select public.oauth_human_context(''authz'')'), 'direct_session_required', 'a chat cannot inspect human authorizations');
select tests.reset_role();

-- Freeze all credential fields, including pending email/phone changes, regardless of the caller.
select is(tests.error_of(format('update auth.users set %I = %L where id = %L::uuid', field, value, :'f'::jsonb->>'agent_user')),
          'agent_credentials_frozen', 'agent credentials reject changes to ' || field)
  from (values ('encrypted_password', 'new-agent-hash'), ('email', 'locked-agent@test.invalid'),
               ('email_change', 'pending-agent@test.invalid'), ('phone', '15555550100'), ('phone_change', '15555550101')) as changes(field, value);
select lives_ok(format('update auth.users set banned_until = now() + interval ''1 hour'' where id = %L::uuid', :'f'::jsonb->>'agent_user'),
                'credential freezing does not block agent bans');
select lives_ok(format('update auth.users set encrypted_password = %L where id = %L::uuid', 'new-human-hash', :'f'::jsonb->>'owner'),
                'a person can still change their password');

-- Keep a tombstone when the agent's workspace is deleted; absence must never recover human reach.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_oauth_link('deleted-workspace', (:'f'::jsonb->>'agent')::uuid);
delete from public.workspaces where id = (:'f'::jsonb->>'ws')::uuid;
select is((select count(*)::int from public.agent_oauth_links where client_id = 'deleted-workspace' and agent_id is null and workspace_id is null), 1,
          'workspace deletion preserves an orphaned link');
select tests.reset_role();
select tests.set_oauth_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid, 'deleted-workspace');
select ok(tests.error_of('select private.apply_session_link()') like '%link_revoked%', 'workspace deletion cannot turn the agent chat into its person');
select tests.reset_role();

select * from finish();
rollback;
