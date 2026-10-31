-- Page sources: a change marks what depends on it and opens one check, a check never writes a page, a contradiction waits
-- for a person, and neither the watcher nor the artifact hook can fail the write that fired it.
begin;
select plan(58);

select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+platform@agents.invalid', 'lead', 'page_B') as pl \gset
update public.agents set is_platform = true, capabilities = '{"start":true}'::jsonb where id = (:'pl'::jsonb->>'agent')::uuid;
-- Match the explicit As-you consent link required by the HTTP session hook.
insert into public.agent_oauth_links (user_id, client_id, as_human)
values ((:'f'::jsonb->>'owner')::uuid, 'chat-client', true);

create function tests.page(p_id text, p_title text, p_text text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'title', p_title, 'parentId', 'page_A', 'blocks',
    jsonb_build_array(jsonb_build_object('id', 'b1', 'type', 'paragraph', 'html', p_text, 'rev', 1),
                      jsonb_build_object('id', 'b2', 'type', 'paragraph', 'html', 'Second block', 'rev', 1)));
$$;
create function tests.edit(p_id text, p_text text) returns void language sql as $$
  update public.pages set data = jsonb_set(data, '{blocks,0,html}', to_jsonb(p_text)), revision = revision + 1 where id = p_id;
$$;
create function tests.age(p_page text) returns void language sql as $$
  update public.page_sources set changed_at = now() - interval '6 minutes' where page_id = p_page and status = 'changed';
$$;
alter table public.pages disable trigger pages_20_revision;

select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_S', 'page_A', tests.page('page_S', 'Pricing', 'Price is 10 USD'));
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_D', 'page_A', tests.page('page_D', 'Proposal', 'We charge 10 USD'));
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_E', 'page_A', tests.page('page_E', 'Summary', 'Short version'));
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_B1', 'page_A', tests.page('page_B1', 'Sales brief', 'For the team'));
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_H', null, tests.page('page_H', 'Hidden', 'Not for the agent') - 'parentId');

-- A. The fingerprint moves with text and files, not with comments or revisions.
select is(private.source_fingerprint(tests.page('x', 't', 'a')), private.source_fingerprint(tests.page('x', 't', 'a')), 'same text, same fingerprint');
select isnt(private.source_fingerprint(tests.page('x', 't', 'a')), private.source_fingerprint(tests.page('x', 't', 'b')), 'other text, other fingerprint');
select is(private.source_fingerprint(tests.page('x', 't', 'a') || '{"comments":[{"text":"hi"}]}'), private.source_fingerprint(tests.page('x', 't', 'a')), 'a comment does not move it');
select is(private.source_fingerprint(jsonb_set(tests.page('x', 't', 'a'), '{blocks,0,rev}', '9')), private.source_fingerprint(tests.page('x', 't', 'a')), 'a revision does not move it');
select isnt(private.source_fingerprint(jsonb_set(tests.page('x', 't', 'a'), '{blocks,0,fileId}', '"f1"')),
            private.source_fingerprint(jsonb_set(tests.page('x', 't', 'a'), '{blocks,0,fileId}', '"f2"')), 'a replaced file moves it');
select is(private.source_fingerprint(tests.page('x', 't', 'a'), 'b2'), private.source_fingerprint(tests.page('x', 'other', 'b'), 'b2'), 'a block ignores the rest of the page');
select is(private.source_fingerprint(tests.page('x', 't', 'a'), 'nope'), 'missing', 'a block that left says so');
select is(private.source_fingerprint(null), 'deleted', 'a deleted page says so');

-- B. Declaring.
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of($$select public.declare_sources('page_D', '[{"page_id":"page_S"}]')$$), 'forbidden', 'a viewer cannot declare');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((public.declare_sources('page_D', '[{"page_id":"page_S"},{"url":"https://example.com/rates"}]'))->>'declared', '2', 'a person declares a page and a URL');
select is((public.declare_sources('page_D', '[{"page_id":"page_S"}]'))->>'declared', '0', 'declaring twice adds nothing');
select is(tests.error_of($$select public.declare_sources('page_D', '[{"url":"javascript:alert(1)"}]')$$), 'invalid_input', 'a URL must be http');
select is(tests.error_of($$select public.declare_sources('page_D', '[{"page_id":"page_S","block_id":"gone"}]')$$), 'block_not_found', 'a block must exist');
select is(tests.error_of($$select public.declare_sources('page_D', '[{"page_id":"page_D"}]')$$), 'source_cycle', 'a page cannot be its own source');
select is(tests.error_of($$select public.declare_sources('page_S', '[{"page_id":"page_D"}]')$$), 'source_cycle', 'a direct cycle is refused');
select public.declare_sources('page_E', '[{"page_id":"page_D"}]');
select is(tests.error_of($$select public.declare_sources('page_S', '[{"page_id":"page_E"}]')$$), 'source_cycle', 'so is a longer one');
select tests.reset_role();
select is((select observed_revision from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'),
          (select revision from public.pages where id = 'page_S'), 'it keeps the revision');
select ok((select observed_at is not null and observed_hash ~ '^[0-9a-f]{32}$' from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'the date and the fingerprint');

-- An agent needs a run, write on the page and read on the source.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_E', '{"objective":"Summarize","sources":[{"kind":"page","ref":"page_D","trust":"internal"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t1 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of($$select public.declare_sources('page_E', '[{"page_id":"page_D"}]')$$), 'invalid_input', 'an agent needs a run');
select public.claim_task(:'t1'::uuid, 'codex') ->> 'run_id' as r1 \gset
select is(tests.error_of(format($$select public.declare_sources('page_E', '[{"page_id":"page_H"}]', %L::uuid)$$, :'r1')), 'not_found', 'an unreadable source does not exist for it');
select is(tests.error_of(format($$select public.declare_sources('page_H', '[{"page_id":"page_S"}]', %L::uuid)$$, :'r1')), 'forbidden', 'nor can it mark a page it cannot write');
select is((select count(*) from public.page_sources), 0::bigint, 'an agent reads no source from the table');
select tests.reset_role();

-- C. The watcher.
select is((select status from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'current', 'it starts current');
select tests.edit('page_S', 'Price is 12 USD');
select is((select status from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'changed', 'an edit marks the dependent');
select is((select status from public.page_sources where page_id = 'page_E'), 'current', 'only the direct dependent');
select tests.edit('page_S', 'Price is 10 USD');
select is((select status || coalesce(changed_at::text, '') from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'current', 'undoing clears the mark');
select tests.edit('page_S', 'Price is 12 USD');
select tests.edit('page_H', 'A page nobody depends on');
select is((select count(*) from public.audit_events where action = 'sources.failed'), 0::bigint, 'nothing failed');

-- D. The tick: a quiet window, one request per page, no grants.
select is(private.source_tick(), 0, 'it waits for the quiet window');
select tests.age('page_D');
select is(private.source_tick(), 1, 'then it opens one check');
select is(private.source_tick(), 0, 'and only one');
select id as chk from public.agent_tasks where request_kind = 'source_check' and row_page_id = 'page_D' \gset
select is((select delegate_agent_id from public.agent_tasks where id = :'chk'::uuid), (:'pl'::jsonb->>'agent')::uuid, 'for the platform agent');
select is((select count(*) from public.agent_grants where agent_id = (:'pl'::jsonb->>'agent')::uuid and page_id = 'page_D'), 0::bigint, 'with no new grant');

-- E. The check reports and writes no page.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.source_check_context(%L::uuid)', :'chk')), 'not_found', 'only the delegate reads the request');
select tests.reset_role();
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select public.claim_task(:'chk'::uuid, 'platform') ->> 'run_id' as pr \gset
select public.source_check_context(:'chk'::uuid) as c \gset
select is(:'c'::jsonb->'sources'->0->>'title', 'Pricing', 'it reads the changed source');
select is(:'c'::jsonb->'page'->>'title', 'Proposal', 'and the page');
select is(tests.error_of(format($$select public.report_source_check(%L::uuid, 'discrepancy', '[{"id":"%s","fingerprint":"deleted","revision":1}]')$$, :'pr', :'c'::jsonb->'sources'->0->>'id')), 'invalid_input', 'a discrepancy needs a summary');
select tests.reset_role();
select tests.edit('page_S', 'Price is 13 USD');
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select (public.report_source_check(:'pr'::uuid, 'current', jsonb_build_array(jsonb_build_object('id', :'c'::jsonb->'sources'->0->>'id',
          'fingerprint', :'c'::jsonb->'sources'->0->>'fingerprint', 'revision', (:'c'::jsonb->'sources'->0->>'revision')::bigint)), 'They agree')) ->> 'verdict';
select tests.reset_role();
select is((select status from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'changed', 'a change during the check stays marked');
select is((select state from public.agent_tasks where id = :'chk'::uuid), 'done', 'the request closed');
select is((select data->'blocks'->0->>'html' from public.pages where id = 'page_D'), 'We charge 10 USD', 'the page was not touched');

-- F. A contradiction opens a discrepancy, and a person settles it.
select tests.age('page_D');
select is(private.source_tick(), 1, 'the next tick looks again');
select id as chk2 from public.agent_tasks where request_kind = 'source_check' and row_page_id = 'page_D' and state <> 'done' \gset
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select public.claim_task(:'chk2'::uuid, 'platform') ->> 'run_id' as pr2 \gset
select public.source_check_context(:'chk2'::uuid) as c2 \gset
select (public.report_source_check(:'pr2'::uuid, 'discrepancy', jsonb_build_array(jsonb_build_object('id', :'c2'::jsonb->'sources'->0->>'id',
          'fingerprint', :'c2'::jsonb->'sources'->0->>'fingerprint', 'revision', (:'c2'::jsonb->'sources'->0->>'revision')::bigint)),
          'The proposal says 10 USD, the pricing page says 13 USD',
          jsonb_build_array(jsonb_build_object('source_id', :'c2'::jsonb->'sources'->0->>'id', 'source_says', 'Price is 13 USD', 'page_says', 'We charge 10 USD')))) ->> 'discrepancy_id' as d1 \gset
select is(public.page_source_state('page_D')->>'discrepancies', '0', 'an agent without access learns nothing');
select tests.reset_role();
select is((select status from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'discrepancy', 'the source waits for a person');
select is(private.source_tick(), 0, 'and no new check opens');
select is((select count(*) from public.notifications where kind = 'source_discrepancy' and user_id = (:'f'::jsonb->>'owner')::uuid), 1::bigint, 'the owner is told');
select tests.set_agent((:'pl'::jsonb->>'user')::uuid, (:'pl'::jsonb->>'agent')::uuid);
select is(tests.error_of(format($$select public.resolve_discrepancy(%L::uuid, 'keep')$$, :'d1')), 'humans_only', 'an agent cannot settle it');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'chat-client');
select is(tests.error_of(format($$select public.resolve_discrepancy(%L::uuid, 'keep')$$, :'d1')), 'direct_session_required', 'nor a chat session');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'dead-client');
select is((select count(*) from public.page_discrepancies), 0::bigint, 'a chat without a live link reads no discrepancy');
select is((select count(*) from public.page_sources), 0::bigint, 'nor a source');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.error_of(format($$select public.resolve_discrepancy(%L::uuid, 'keep')$$, :'d1')), 'forbidden', 'nor a viewer');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.resolve_discrepancy(:'d1'::uuid, 'update', 'The price did change') ->> 'task_id' as fu \gset
select is(tests.error_of(format($$select public.resolve_discrepancy(%L::uuid, 'keep')$$, :'d1')), 'discrepancy_resolved', 'a decision is final');
select tests.reset_role();
select is((select delegate_agent_id from public.agent_tasks where id = :'fu'::uuid), (:'pl'::jsonb->>'agent')::uuid, 'update opens work for the platform agent');
select is((select status from public.page_sources where page_id = 'page_D' and source_page_id = 'page_S'), 'current', 'and the source counts as observed');

-- G. A delivered page picks up the sources of its brief, and a failure here never fails the write that fired it.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.add_artifact(:'r1'::uuid, 'page', 'page_E', 'Summary');
select tests.reset_role();
select is((select count(*) from public.page_sources where page_id = 'page_E' and source_page_id = 'page_D'), 1::bigint, 'a source already declared stays once');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_B1', '{"objective":"Brief the sales team","sources":[{"kind":"page","ref":"page_S","trust":"internal"},{"kind":"url","ref":"https://example.com"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t2 \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t2'::uuid, 'codex') ->> 'run_id' as r2 \gset
select public.add_artifact(:'r2'::uuid, 'page', 'page_B1', 'Brief');
select tests.reset_role();
select is((select created_by_type || ':' || status from public.page_sources where page_id = 'page_B1' and source_page_id = 'page_S'), 'agent:current', 'a delivery declares the page sources of its brief');
select is((select count(*) from public.page_sources where page_id = 'page_B1' and source_kind = 'url'), 0::bigint, 'and only pages');

create or replace function private.source_fingerprint(p_data jsonb, p_block text default null)
returns text language plpgsql immutable as $$ begin raise exception 'boom'; end $$;
select lives_ok($$select tests.edit('page_S', 'Price is 14 USD')$$, 'a page write survives a broken watcher');
select is((select count(*) from public.audit_events where action = 'sources.failed'), 1::bigint, 'and the failure is recorded');
select is((select data->'blocks'->0->>'html' from public.pages where id = 'page_S'), 'Price is 14 USD', 'with the new text in place');

select * from finish();
rollback;
