-- The minute tick behind the Notion invitations: only pg_cron runs it.
begin;
select no_plan();
select tests.fixture() as f \gset

select tests.set_anon();
select is(tests.sqlstate_of($$select private.waitlist_invites_tick()$$), '42501', 'anon cannot run the tick');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of($$select private.waitlist_invites_tick()$$), '42501', 'the workspace owner cannot run the tick');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of($$select private.waitlist_invites_tick()$$), '42501', 'an agent cannot run the tick');
select tests.reset_role();

select ok(not has_function_privilege('anon','private.waitlist_invites_tick()','execute'), 'anon has no execute grant');
select ok(not has_function_privilege('authenticated','private.waitlist_invites_tick()','execute'), 'authenticated has no execute grant');
select ok(not has_function_privilege('service_role','private.waitlist_invites_tick()','execute'), 'the service role has no execute grant');
select lives_ok($$select private.waitlist_invites_tick()$$, 'the tick runs without configured secrets');

select * from finish();
rollback;
