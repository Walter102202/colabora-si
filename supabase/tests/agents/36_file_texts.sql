-- read_file: only the platform agent saves the text of a file, from its own run and for a file on a page it can
-- read; the text is readable by exactly those who can read a page that holds the file.
begin;
select plan(18);

select tests.fixture() as f \gset
insert into public.files (id, workspace_id, created_by, created_by_type) values ('file_1', (:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, 'human');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_F', 'page_A', jsonb_build_object('id', 'page_F', 'title', 'Deck', 'parentId', 'page_A',
  'blocks', jsonb_build_array(jsonb_build_object('id', 'blk_f', 'type', 'file', 'html', '', 'indent', 0, 'rev', 1,
    'fileId', 'file_1', 'fileName', 'deck.pdf', 'fileSize', 1024))));
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Read the deck"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as task \gset
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'task'::uuid, 'custom') ->> 'run_id' as run \gset
select '[{"page":1,"text":"Revenue grew 20%"}]' as pages \gset

-- A. Who saves.
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'ready', %L::jsonb)$$, :'run', :'pages')),
          'platform_only', 'an agent that is not the platform agent cannot save a file text');
select tests.reset_role();
update public.agents set is_platform = true where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(public.save_file_text(:'run'::uuid, 'page_F', 'file_1', 'ready', :'pages'::jsonb, 1, 'application/pdf', 'muse-spark-1.3', 0.002)
            ->> 'chars', '16', 'the platform agent saves it');
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_A1', 'file_1', 'ready', %L::jsonb)$$, :'run', :'pages')),
          'not_found', 'only for a page that holds the file');
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'done', %L::jsonb)$$, :'run', :'pages')),
          'invalid_input', 'the status is one of four');
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'ready', '[{"page":1}]'::jsonb)$$, :'run')),
          'invalid_input', 'an extracted page must contain text');
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'ready', '[{"text":"Missing number"}]'::jsonb)$$, :'run')),
          'invalid_input', 'an extracted page must contain a page number');
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'ready', '[{"page":-1.5,"text":"Bad page"}]'::jsonb)$$, :'run')),
          'invalid_input', 'page numbers must be positive integers');
select public.save_file_text(:'run'::uuid, 'page_F', 'file_1', 'partial', '[{"page":1,"text":"Revenue grew 20%"},{"page":2,"text":"Costs"}]'::jsonb, 9);
select tests.reset_role();
select is((select status || ':' || total_pages from public.file_texts where file_id = 'file_1'), 'partial:9', 'a second save replaces the first');
select is((select count(*) from public.agent_activities where run_id = :'run'::uuid and body->>'op' = 'read_file'), 2::bigint,
          'each save leaves an activity on the run');
select is((select body->>'summary' from public.agent_activities where run_id = :'run'::uuid and body->>'op' = 'read_file' order by seq limit 1),
          'Read deck.pdf: 1 page(s) with muse-spark-1.3', 'which says what was read and with which model');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.error_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'ready', %L::jsonb)$$, :'run', :'pages')),
          'agent_disabled', 'a person cannot save a file text');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format($$select public.save_file_text(%L::uuid, 'page_F', 'file_1', 'ready', %L::jsonb)$$, :'run', :'pages')),
          '42501', 'a signed-out caller cannot call it');
select tests.reset_role();

-- B. Who reads.
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select count(*) from public.file_texts), 1::bigint, 'a member who reads the page reads the text');
select tests.reset_role();
select tests.make_user('outsider@test.local') as outsider \gset
select tests.set_human(:'outsider'::uuid);
select is((select count(*) from public.file_texts), 0::bigint, 'someone outside the workspace does not');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*) from public.file_texts), 1::bigint, 'an agent with a read grant on the page reads it');
select tests.reset_role();
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'b@agents.invalid', 'worker', 'page_B') as other \gset
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is((select count(*) from public.file_texts), 0::bigint, 'an agent without a grant on the page does not');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('page_F', '[{"op":"delete_block","id":"blk_f"}]'::jsonb);
select is((select count(*) from public.file_texts), 0::bigint, 'when no page holds the file any more, nobody reads its text');
select tests.reset_role();
select is((select count(*) from public.file_texts where file_id = 'file_1'), 1::bigint, 'the text itself is kept');

select * from finish();
rollback;
