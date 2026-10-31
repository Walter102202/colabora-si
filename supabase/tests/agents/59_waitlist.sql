-- The landing's waitlist: only the service role reaches it.
begin;
select no_plan();
select tests.fixture() as f \gset
create temporary table calls(sql text);
insert into calls values
 ($$select public.waitlist_join('ana@company.co','hash')$$),
 ($$select public.waitlist_mark_synced('00000000-0000-4000-8000-000000000001')$$),
 ($$select * from private.waitlist$$),
 ($$select * from private.waitlist_attempts$$),
 ($$insert into private.waitlist(email) values ('ana@company.co')$$);
grant select on calls to authenticated, anon;

select tests.set_anon();
select is(tests.sqlstate_of(sql), '42501', 'anon cannot: '||sql) from calls;
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(sql), '42501', 'the workspace owner cannot: '||sql) from calls;
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(sql), '42501', 'an agent cannot: '||sql) from calls;
select tests.reset_role();

select ok(has_table_privilege('service_role','private.waitlist','select') is false, 'the service role also goes through the RPC');
select ok((select relrowsecurity from pg_class where oid='private.waitlist'::regclass), 'row level security is on');
select is((select count(*)::int from pg_policies where schemaname='private' and tablename in ('waitlist','waitlist_attempts')), 0, 'no policy opens the tables');

select tests.set_service();
select is(public.waitlist_join('  Ana@Company.CO ','ip-1')->>'outcome', 'added', 'a new address joins');
select is(public.waitlist_join('ana@company.co','ip-2')->>'outcome', 'exists', 'the normalized address repeats');
select is(tests.sqlstate_of($$select public.waitlist_join('not an email','ip-3')$$), 'PT400', 'a malformed address is refused');
select tests.reset_role();
select is((select count(*)::int from private.waitlist where email='ana@company.co'), 1, 'one row per address');
select is((select source from private.waitlist where email='ana@company.co'), 'landing', 'the source defaults to the landing');
select is((select notion_synced_at from private.waitlist where email='ana@company.co'), null, 'a new row starts unsynced');
select is((select count(*)::int from private.waitlist_attempts where key like '%ana%' or key like '%company%'), 0, 'attempts keep no address');

select tests.set_service();
select public.waitlist_mark_synced((public.waitlist_join('sync@company.co','ip-sync')->>'id')::uuid);
select tests.reset_role();
select isnt((select notion_synced_at from private.waitlist where email='sync@company.co'), null, 'a copied row is marked');

select tests.set_service();
select public.waitlist_join('same@company.co','ip-email-'||i) from generate_series(1,5) i;
select is(public.waitlist_join('same@company.co','ip-email-6')->>'outcome', 'rate_limited', 'one address is limited across addresses of origin');
select public.waitlist_join('crowd-'||i||'@company.co','ip-crowd') from generate_series(1,20) i;
select is(public.waitlist_join('crowd-21@company.co','ip-crowd')->>'outcome', 'rate_limited', 'one origin is limited across addresses');
select tests.reset_role();
select is((select count(*)::int from private.waitlist where email='crowd-21@company.co'), 0, 'a limited attempt saves nothing');

insert into private.waitlist_attempts(key,window_start,attempts) values ('ip:old',now()-interval '2 hours',99);
select tests.set_service();
select public.waitlist_join('fresh@company.co','ip-fresh');
select tests.reset_role();
select is((select count(*)::int from private.waitlist_attempts where key='ip:old'), 0, 'old windows are purged');

select * from finish();
rollback;
