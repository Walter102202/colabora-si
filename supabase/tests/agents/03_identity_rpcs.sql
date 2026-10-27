begin;
select plan(15);

select tests.fixture() as f \gset
select tests.make_user('agent+second@agents.invalid') as u2 \gset

-- create_agent is service_role only
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format(
  'select public.create_agent(%L::uuid, %L::uuid, %L::uuid, %L, %L)',
  :'f'::jsonb->>'ws', :'f'::jsonb->>'owner', :'u2', 'Second', 'webhook')), '42501', 'authenticated cannot call create_agent');

select tests.reset_role();
select tests.set_service();
select is(tests.sqlstate_of(format(
  'select public.create_agent(%L::uuid, %L::uuid, %L::uuid, %L, %L)',
  :'f'::jsonb->>'ws', :'f'::jsonb->>'viewer', :'u2', 'Second', 'webhook')), 'PT403', 'a viewer cannot create agents');
select is(tests.sqlstate_of(format(
  'select public.create_agent(%L::uuid, %L::uuid, %L::uuid, %L, %L, %L, null, %L::jsonb)',
  :'f'::jsonb->>'ws', :'f'::jsonb->>'owner', :'u2', 'Second', 'webhook', 'worker', '{"start": true, "bogus": true}')), 'PT400', 'unknown capability is rejected');
select public.create_agent((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, :'u2'::uuid, 'Second', 'webhook', 'worker', null, '{"start": true, "continue": true}'::jsonb) ->> 'agent_id' as a2 \gset
select is((select count(*)::int from public.agents where id = :'a2'::uuid), 1, 'create_agent inserts the agent');

-- grants
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.sqlstate_of(format('select public.grant_agent_page(%L::uuid, %L, array[%L])', :'a2', 'page_B', 'read')), 'PT403', 'a viewer cannot grant');

select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
insert into public.workspaces (id, name, owner_id) values ('11111111-1111-4111-8111-111111111111', 'Other', (:'f'::jsonb->>'owner')::uuid);

insert into public.pages (id, workspace_id, data) values ('page_other', '11111111-1111-4111-8111-111111111111', '{"id":"page_other","title":"Other","blocks":[]}'::jsonb);
select is(tests.sqlstate_of(format('select public.grant_agent_page(%L::uuid, %L, array[%L])', :'a2', 'page_other', 'read')), 'PT422', 'cross-workspace grant is rejected');
select lives_ok(format('select public.grant_agent_page(%L::uuid, %L, array[%L,%L])', :'a2', 'page_B', 'read', 'write'), 'owner grants page_B to the second agent');

-- tokens
select public.issue_agent_token(:'a2'::uuid, 'laptop') as t \gset
select is(length(:'t'::jsonb->>'token'), 44, 'token is agt_ plus 40 chars');
select is(left(:'t'::jsonb->>'token', 4), 'agt_', 'token has the agt_ prefix');
select tests.reset_role();
select is((select token_hash from public.agent_tokens where id = (:'t'::jsonb->>'token_id')::uuid),
          encode(extensions.digest(convert_to('test-pepper' || (:'t'::jsonb->>'token'), 'utf8'), 'sha256'), 'hex'),
          'token_hash is sha256(pepper || token)');

select tests.reset_role();
select tests.set_service();
select is(public.lookup_agent_token(encode(extensions.digest(convert_to('test-pepper' || (:'t'::jsonb->>'token'), 'utf8'), 'sha256'), 'hex')) ->> 'agent_id',
          :'a2', 'lookup_agent_token resolves the agent');
select ok((select last_used_at from public.agent_tokens where id = (:'t'::jsonb->>'token_id')::uuid) is not null, 'lookup stamps last_used_at');

select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revoke_agent_token((:'t'::jsonb->>'token_id')::uuid);
select tests.reset_role();
select tests.set_service();
select is(public.lookup_agent_token(encode(extensions.digest(convert_to('test-pepper' || (:'t'::jsonb->>'token'), 'utf8'), 'sha256'), 'hex')), null, 'revoked token no longer resolves');

-- whoami + revoke_agent in the same session
select tests.reset_role();
select tests.set_agent(:'u2'::uuid, :'a2'::uuid);
select is(public.whoami() ->> 'principal_type', 'agent', 'whoami reports an agent principal');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.revoke_agent(:'a2'::uuid, 'test');
select tests.reset_role();
select tests.set_agent(:'u2'::uuid, :'a2'::uuid);
select ok(private.current_agent_id() is null, 'revoked agent has no current_agent_id in the same session');

select * from finish();
rollback;
