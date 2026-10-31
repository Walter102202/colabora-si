-- Private pages: only the owner reaches one, from a direct session, through every path that reads a page.
begin;
select plan(29);

select tests.fixture() as f \gset
select tests.make_user('editor@test.local') as editor \gset
insert into public.workspace_members (workspace_id, user_id, role) values ((:'f'::jsonb->>'ws')::uuid, :'editor'::uuid, 'editor');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_P', null,
  '{"id":"page_P","title":"My secrets","parentId":null,"blocks":[{"id":"bp","type":"paragraph","html":"pineapple","indent":0,"rev":1}],"isDeleted":false}'::jsonb);
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_L', null,
  '{"id":"page_L","title":"Public","parentId":null,"blocks":[{"id":"bl","type":"page","html":"","pageId":"page_P","indent":0,"rev":1}],"isDeleted":false}'::jsonb);
insert into public.private_pages (page_id, workspace_id, owner_user_id, root_page_id)
values ('page_P', (:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, 'page_P');
insert into public.agent_grants (workspace_id, agent_id, page_id, scopes, inherit, granted_by)
values ((:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'agent')::uuid, 'page_P', array['read','write'], true, (:'f'::jsonb->>'owner')::uuid);
insert into public.agent_oauth_links (user_id, client_id, as_human) values ((:'f'::jsonb->>'owner')::uuid, 'chat-client', true);
alter table public.pages disable trigger user;
update public.pages set published = true where id = 'page_L';
alter table public.pages enable trigger user;

-- A. The owner, and nobody else.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is((select count(*) from public.pages where id = 'page_P'), 1::bigint, 'the owner reads the page');
select ok(private.can_write_page('page_P', (:'f'::jsonb->>'ws')::uuid), 'the owner writes it');
select is((select count(*) from public.private_pages), 1::bigint, 'and sees it listed as private');
select is(jsonb_array_length(public.search_workspace((:'f'::jsonb->>'ws')::uuid, 'pineapple')), 1, 'the owner finds it in search');
select tests.reset_role();

select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select count(*) from public.pages where id = 'page_P'), 0::bigint, 'a member does not read it');
select is((select count(*) from public.pages where id = 'page_B'), 1::bigint, 'a member still reads an ordinary page');
select is((select count(*) from public.private_pages), 0::bigint, 'and sees no row of the list');
select is(jsonb_array_length(public.search_workspace((:'f'::jsonb->>'ws')::uuid, 'pineapple')), 0, 'search finds nothing');
select is(public.get_page_bundle('page_P'), null, 'the bundle answers nothing');
select tests.reset_role();

select tests.set_human(:'editor'::uuid);
select is((select count(*) from public.pages where id = 'page_P'), 0::bigint, 'an editor does not read it either');
select ok(not private.can_write_page('page_P', (:'f'::jsonb->>'ws')::uuid), 'nor write it');
with touched as (update public.pages set published = true where id = 'page_P' returning 1)
select is((select count(*) from touched), 0::bigint, 'an editor cannot publish it');
with gone as (delete from public.pages where id = 'page_P' returning 1)
select is((select count(*) from gone), 0::bigint, 'nor delete it');
select tests.reset_role();

insert into public.page_shares (page_id, user_id, level) values ('page_P', :'editor'::uuid, 'edit');
select tests.set_human(:'editor'::uuid);
select is((select count(*) from public.pages where id = 'page_P'), 0::bigint, 'a share does not open it');
select tests.reset_role();

select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select ok(not private.can_read_page('page_P', (:'f'::jsonb->>'ws')::uuid), 'a grant does not open it for an agent');
select ok(not private.agent_can('page_P', 'write'), 'not even through agent_can');
select tests.reset_role();

select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'chat-client');
select is((select count(*) from public.pages where id = 'page_P'), 0::bigint, 'a chat session acting as the owner stays out');
select tests.reset_role();

-- B. A bundle does not carry it along.
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select ok(not (public.get_page_bundle('page_L')->'pages') ? 'page_P', 'a page that links to it does not bring it to a member');
select tests.reset_role();
select tests.set_anon();
select ok(not (public.get_page_bundle('page_L')->'pages') ? 'page_P', 'nor to the public');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select ok((public.get_page_bundle('page_L')->'pages') ? 'page_P', 'the owner gets it');
select tests.reset_role();

-- C. What sits under it is private too.
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_C', 'page_P');
select is((select owner_user_id from public.private_pages where page_id = 'page_C'), (:'f'::jsonb->>'owner')::uuid, 'a new subpage inherits');
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_T', null);
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_T1', 'page_T');
alter table public.pages disable trigger pages_30_actor;
update public.pages set parent_id = 'page_P' where id = 'page_T';
select is((select count(*) from public.private_pages where page_id in ('page_T','page_T1')), 2::bigint, 'a tree moved in inherits whole');
update public.pages set parent_id = null where id = 'page_T';
alter table public.pages enable trigger pages_30_actor;
select is((select count(*) from public.private_pages where page_id in ('page_T','page_T1')), 2::bigint, 'moving it out keeps it private');

-- D. A task on a private page stays out of other people's lists; its delegate keeps it.
insert into public.agent_tasks (id, workspace_id, context_id, row_page_id, title, delegate_agent_id, owner_user_id, created_by, created_by_type, request_kind)
values ('00000000-0000-4000-8000-00000000a001', (:'f'::jsonb->>'ws')::uuid, '00000000-0000-4000-8000-00000000a001', 'page_P', 'Private', (:'f'::jsonb->>'agent')::uuid,
        (:'f'::jsonb->>'owner')::uuid, (:'f'::jsonb->>'owner')::uuid, 'human', 'fill');
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select count(*) from public.agent_tasks where id = '00000000-0000-4000-8000-00000000a001'), 0::bigint, 'another member does not see the task');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*) from public.agent_tasks where id = '00000000-0000-4000-8000-00000000a001'), 1::bigint, 'its delegate does');
select tests.reset_role();

-- E. The list is the server's, and only the owner removes a private page.
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner \gset
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$insert into public.private_pages (page_id, workspace_id, owner_user_id, root_page_id) values ('page_B', %L, %L, 'page_B')$q$, :'ws', :'owner')),
          '42501', 'nobody writes the list directly');
select is(tests.sqlstate_of($q$delete from public.private_pages$q$), '42501', 'nor deletes from it');
with gone as (delete from public.pages where id = 'page_C' returning 1)
select is((select count(*) from gone), 1::bigint, 'the owner deletes their page');
select tests.reset_role();

-- F. Publishing stays the owner's call.
alter table public.pages disable trigger user;
update public.pages set published = true where id = 'page_P';
alter table public.pages enable trigger user;
select tests.set_anon();
select is((select count(*) from public.pages where id = 'page_P'), 1::bigint, 'a page its owner published is public');
select tests.reset_role();

select * from finish();
rollback;
