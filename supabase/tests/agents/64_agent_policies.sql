-- Agent policies can only be changed by the owner from a direct app session.
begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_user('policies-outsider@test.local') as outsider \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'policies-lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'policies-revoked@agents.invalid', 'worker', 'page_A') as revoked \gset
update public.agents set revoked_at = now() where id = (:'revoked'::jsonb->>'agent')::uuid;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'policies-platform@agents.invalid', 'lead', 'page_A') as platform_agent \gset
update public.agents set is_platform = true where id = (:'platform_agent'::jsonb->>'agent')::uuid;
select :'platform_agent'::jsonb->>'agent' as platform \gset
insert into public.agent_oauth_links(user_id, client_id, as_human) values ((:'f'::jsonb->>'owner')::uuid, 'policy-chat', true);

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'f'::jsonb->>'agent', 'lead')), 'humans_only', 'agents cannot change roles');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'f'::jsonb->>'agent', 'autonomous')), 'humans_only', 'agents cannot change autonomy');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'policy-chat');
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'f'::jsonb->>'agent', 'lead')), 'direct_session_required', 'chat cannot change roles');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'f'::jsonb->>'agent', 'autonomous')), 'direct_session_required', 'chat cannot change autonomy');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'f'::jsonb->>'agent', 'lead')), 'owner_required', 'members cannot change roles');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'f'::jsonb->>'agent', 'autonomous')), 'owner_required', 'members cannot change autonomy');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.set_agent_role(%L, %L)', :'f'::jsonb->>'agent', 'lead')), '42501', 'anon cannot change roles');
select is(tests.sqlstate_of(format('select public.set_agent_autonomy(%L, %L)', :'f'::jsonb->>'agent', 'autonomous')), '42501', 'anon cannot change autonomy');
select tests.reset_role();
select tests.set_human(:'outsider'::uuid);
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'f'::jsonb->>'agent', 'lead')), 'not_found', 'outside-workspace agent is hidden');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'f'::jsonb->>'agent', 'autonomous')), 'not_found', 'outside-workspace policy is hidden');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'platform', 'worker')), 'platform_agent', 'Trama role is immutable');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'platform', 'ask')), 'platform_agent', 'Trama autonomy is immutable');
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'revoked'::jsonb->>'agent', 'lead')), 'not_found', 'revoked role is hidden');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'revoked'::jsonb->>'agent', 'ask')), 'not_found', 'revoked autonomy is hidden');
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'f'::jsonb->>'agent', 'owner')), 'invalid_input', 'invalid role refused');
select is(tests.error_of(format('select public.set_agent_role(%L, null)', :'f'::jsonb->>'agent')), 'invalid_input', 'null role refused');
select is(tests.error_of(format('select public.set_agent_autonomy(%L, %L)', :'f'::jsonb->>'agent', 'reckless')), 'invalid_input', 'invalid autonomy refused');
select is(tests.error_of(format('select public.update_agent(%L, %L::jsonb)', :'f'::jsonb->>'agent', '{"role":"lead"}')), 'field_not_allowed', 'generic update cannot change role');
select is(tests.error_of(format('select public.update_agent(%L, %L::jsonb)', :'f'::jsonb->>'agent', '{"autonomy":"autonomous"}')), 'field_not_allowed', 'generic update cannot change autonomy');
select public.set_agent_role((:'f'::jsonb->>'agent')::uuid, 'lead');
select public.set_agent_role((:'f'::jsonb->>'agent')::uuid, 'worker');
select public.set_agent_autonomy((:'f'::jsonb->>'agent')::uuid, 'balanced');
select is(tests.sqlstate_of(format('update public.agents set autonomy = %L where id = %L', 'autonomous', :'f'::jsonb->>'agent')), '', 'direct policy update cannot bypass RPC');
select tests.reset_role();
select is((select role from public.agents where id = (:'f'::jsonb->>'agent')::uuid), 'worker', 'owner changes role');
select is((select autonomy from public.agents where id = (:'f'::jsonb->>'agent')::uuid), 'balanced', 'owner changes autonomy');
select ok(exists(select 1 from public.audit_events where action = 'agent.role_set' and target->>'agent_id' = :'f'::jsonb->>'agent'), 'role change audited');
select ok(exists(select 1 from public.audit_events where action = 'agent.autonomy_set' and target->>'agent_id' = :'f'::jsonb->>'agent'), 'autonomy change audited');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['policy-parent','policy-child','policy-alone']) p;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'autonomous');
select public.set_agent_autonomy((:'lead'::jsonb->>'agent')::uuid, 'balanced');
select public.set_agent_autonomy((:'f'::jsonb->>'agent')::uuid, 'autonomous');
select public.create_agent_task('policy-parent', '{"objective":"Open job"}', (:'lead'::jsonb->>'agent')::uuid)->>'task_id' as parent \gset
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'lead'::jsonb->>'agent', 'worker')), 'lead_has_open_work', 'open lead cannot be demoted');
select is(tests.detail_of(format('select public.set_agent_role(%L, %L)', :'lead'::jsonb->>'agent', 'worker')), 'policy-parent', 'demotion error identifies job title');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'custom')->>'run_id' as lead_run \gset
select public.create_subtask(:'parent'::uuid, 'policy-child', '{"objective":"Worker task"}', (:'f'::jsonb->>'agent')::uuid)->>'task_id' as child \gset
select is(public.task_autonomy(:'child'::uuid)->>'level', 'balanced', 'worker cannot exceed Lead');
select is(public.task_autonomy(:'child'::uuid)->>'source', 'parent', 'parent ceiling identified');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('policy-alone', '{"objective":"Independent task"}', (:'f'::jsonb->>'agent')::uuid)->>'task_id' as alone \gset
select public.set_task_autonomy(:'alone'::uuid, 'autonomous');
select public.set_agent_autonomy((:'f'::jsonb->>'agent')::uuid, 'balanced');
select is(public.task_autonomy(:'alone'::uuid)->>'level', 'balanced', 'agent caps higher task autonomy');
select is(public.task_autonomy(:'alone'::uuid)->>'source', 'agent', 'agent ceiling identified');
select public.set_agent_autonomy((:'f'::jsonb->>'agent')::uuid, 'ask');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'alone'::uuid, 'custom')->>'run_id' as run \gset
select is(public.request_approval(:'run'::uuid, 'publish_page', '{"page_id":"policy-alone"}')->>'status', 'pending', 'Ask agent does not publish alone');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'f'::jsonb->>'agent')::uuid, 'autonomous');
select public.update_brief(:'alone'::uuid, '{"policies":{"preapproved":["publish_page"]}}');
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'ask');
select is(public.task_autonomy(:'alone'::uuid)->>'level', 'ask', 'workspace Ask stops autonomous agent');
select is(public.task_autonomy(:'alone'::uuid)->>'source', 'workspace', 'workspace stop identified');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'run'::uuid, 'send_email', '{"to":"a@b.test"}')->>'status', 'pending', 'workspace Ask stops what the agent level would allow');
select is(public.request_approval(:'run'::uuid, 'publish_page', '{"page_id":"policy-alone"}')->>'status', 'pending', 'workspace Ask also stops trusted brief preapprovals');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_workspace_autonomy((:'f'::jsonb->>'ws')::uuid, 'autonomous');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.request_approval(:'run'::uuid, 'payment', '{"amount":10}')->>'status', 'pending', 'payment always asks');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.set_agent_autonomy((:'f'::jsonb->>'agent')::uuid, null);
select tests.reset_role();
select is((select autonomy from public.agents where id = (:'f'::jsonb->>'agent')::uuid), null::text, 'null restores workspace default');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.task_autonomy(:'alone'::uuid)->>'level', 'autonomous', 'unset agent retains existing task policy');
select tests.reset_role();
update public.agent_tasks set state = 'done' where id in (:'parent'::uuid, :'child'::uuid);
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format('select public.set_agent_role(%L, %L)', :'lead'::jsonb->>'agent', 'worker')), '', 'finished Lead can become Worker');
select tests.reset_role();
select * from finish();
rollback;
