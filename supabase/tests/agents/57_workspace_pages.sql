-- P14 pages: each public entry repeats authorization through the shared checked dispatcher.
begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'private_P');
insert into public.private_pages values ('private_P', (:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, 'private_P', now());
insert into public.agent_oauth_links(user_id,client_id,as_human) values ((:'f'::jsonb->>'owner')::uuid,'p14-chat',true);
create temporary table calls(name text, args jsonb);
insert into calls values
 ('create_page','{"parent_id":"page_A","title":"New"}'),
 ('update_page','{"page_id":"page_A","title":"Changed"}'),
 ('move_page','{"page_id":"page_A","parent_id":"page_B"}'),
 ('duplicate_page','{"page_id":"page_A","parent_id":"page_B"}'),
 ('archive_page','{"page_id":"page_A"}'),
 ('restore_page','{"page_id":"page_A"}');
grant select on calls to authenticated, anon;
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,args,'deny')), '42501', name||' rejects anon') from calls;
select tests.reset_role();
select tests.make_user('outside-p14@test.local') as outsider \gset
insert into public.workspaces(name,owner_id) values('Other workspace',:'outsider'::uuid);
select tests.set_human(:'outsider'::uuid);
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,args,'other-workspace')), 'PT403', name||' rejects another workspace member') from calls;
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,args,'deny')), 'PT403', name||' rejects read-only') from calls;
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,replace(args::text,'page_A','page_B'),'deny')), 'PT403', name||' rejects missing grant') from calls;
select tests.reset_role();
update public.agents set status='disabled' where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,args,'deny')), 'PT403', name||' rejects revoked agent') from calls;
select tests.reset_role();
update public.agents set status='enabled' where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid, 'p14-chat');
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,replace(args::text,'page_A','private_P'),'deny')), 'PT403', name||' OAuth cannot reach private page') from calls;
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('page_A','[{"op":"set_page","patch":{"locked":true}}]');
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,args,'deny')), 'PT423', name||' rejects locked page') from calls;
select public.apply_page_ops('page_A','[{"op":"set_page","patch":{"locked":false}}]');
select is(tests.error_of($q$select public.move_page('{"page_id":"page_A","parent_id":"page_A1"}','cycle')$q$),'page_cycle','cannot move into descendants');
select is(tests.error_of($q$select public.move_page('{"page_id":"page_A","parent_id":"private_P"}','private')$q$),'page_shared','cannot hide a page other members read');
select public.create_page(jsonb_build_object('workspace_id',(:'f'::jsonb->>'ws'),'title','Root'),'root') as root \gset
select ok((select root_order ? (:'root'::jsonb->>'id') from public.workspaces where id=(:'f'::jsonb->>'ws')::uuid),'human root is ordered');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.create_page(%L::jsonb,%L)',jsonb_build_object('workspace_id',(:'f'::jsonb->>'ws'),'title','Root'),'agent-root')),'parent_required','agent cannot create root');
select public.create_page('{"parent_id":"page_A","title":"Agent page","blocks":[{"type":"paragraph","text":"hello"}]}','create') as created \gset
select is(public.create_page('{"parent_id":"page_A","title":"Agent page"}','create'), :'created'::jsonb,'retry returns first result');
select is((select last_edited_by_type from public.pages where id=(:'created'::jsonb->>'id')),'agent','attribution sealed');
select is(coalesce(current_setting('app.ops_write',true),''),'','write capability cleared');
select public.update_page(jsonb_build_object('page_id',(:'created'::jsonb->>'id'),'title','Renamed'),'rename');
select is((select title from public.pages where id=(:'created'::jsonb->>'id')),'Renamed','updates title');
select public.duplicate_page(jsonb_build_object('page_id',(:'created'::jsonb->>'id'),'parent_id','page_A'),'copy') as copy \gset
select isnt(:'copy'::jsonb->>'id',:'created'::jsonb->>'id','duplicate has new identity');
select public.archive_page(jsonb_build_object('page_id',(:'created'::jsonb->>'id')),'archive');
select ok((select deleted_at is not null from public.pages where id=(:'created'::jsonb->>'id')),'archive keeps data');
select public.restore_page(jsonb_build_object('page_id',(:'created'::jsonb->>'id')),'restore');
select ok((select deleted_at is null from public.pages where id=(:'created'::jsonb->>'id')),'restore clears deletion');
select tests.reset_role();
-- Publication must not make private pages reachable through workspace tools.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
update public.pages set published=true where id='private_P';
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(public.workspace_page_bundle('private_P'),null,'published private page stays out of workspace reads');
select is((select count(*) from public.workspace_visible_pages where id='private_P'),0::bigint,'published private page stays out of lists');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.workspace_comment('page_A','Retry-safe comment',null,null,'comment') as comment \gset
select is(public.workspace_comment('page_A','Retry-safe comment',null,null,'comment'),:'comment'::jsonb,'comment retries return same result');
select is((select count(*) from public.pages p,lateral jsonb_array_elements(p.data->'comments') c where p.id='page_A' and c->>'body'='Retry-safe comment'),1::bigint,'comment retry never duplicates');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.apply_page_ops('page_A','[{"op":"insert_block","block":{"id":"original-sync","type":"synced","html":""}}]');
select public.duplicate_page('{"page_id":"page_A","parent_id":"page_B"}','sync-copy') as sync_copy \gset
select is((select b->>'syncedFrom' from public.pages p,lateral jsonb_array_elements(p.data->'blocks') b where p.id=:'sync_copy'::jsonb->>'id' and b->>'type'='synced'),'original-sync','duplicating original synced blocks preserves source key');
select public.apply_page_ops('private_P','[{"op":"insert_block","block":{"id":"private-sync","type":"synced","html":""}}]');
select public.apply_page_ops('page_B','[{"op":"insert_block","block":{"id":"transclusion","type":"synced","pageId":"private_P","syncedFrom":"private-sync","html":""}}]');
select public.apply_workspace_ops((:'f'::jsonb->>'ws')::uuid,'[{"op":"synced_set","key":"private-sync","blocks":[{"id":"secret","type":"paragraph","html":"private content"}]}]');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select ok(not (public.workspace_page_bundle('page_B')->'syncedBlocks') ? 'private-sync','workspace bundle never carries synced content from a private page');
select tests.reset_role();
select * from finish();
rollback;
