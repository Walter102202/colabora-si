-- P14 database boundary and atomic batch behavior.
begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'private_P');
insert into public.private_pages values ('private_P', (:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, 'private_P', now());
insert into public.agent_oauth_links(user_id,client_id,as_human) values ((:'f'::jsonb->>'owner')::uuid,'p14-chat',true);
create temporary table calls(name text, args jsonb);
insert into calls values
 ('create_database','{"parent_id":"page_A","title":"CRM"}'),
 ('update_database','{"database_id":"page_A","properties":[]}'),
 ('set_view','{"database_id":"page_A","view":{"name":"Board","type":"board"}}'),
 ('delete_view','{"database_id":"page_A","name":"Board"}'),
 ('add_rows','{"database_id":"page_A","rows":[]}'),
 ('delete_row','{"database_id":"page_A","row_id":"row"}');
grant select on calls to authenticated, anon;
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.%I(%L::jsonb,%L)',name,args,'deny')), '42501', name||' rejects anon') from calls;
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
select public.create_database('{"parent_id":"page_A","title":"CRM","properties":[{"name":"Stage","type":"select"}],"views":[{"name":"Board","type":"board","group_by":"Stage"}],"rows":[{"cells":{"Name":{"text":"Acme"},"Stage":{"select":"New"}}}]}','crm') as crm \gset
select is((select jsonb_array_length(data->'database'->'rows') from public.pages where id=(:'crm'::jsonb->>'id')),1,'atomic database has first row');
select is(public.create_database('{"parent_id":"page_A","title":"CRM"}','crm'),:'crm'::jsonb,'creation retry stable');
select is((select data->'database'->'views'->0->>'groupBy' from public.pages where id=(:'crm'::jsonb->>'id')),
 (select data->'database'->'properties'->1->>'id' from public.pages where id=(:'crm'::jsonb->>'id')),'group by resolves property name');
select is(tests.error_of(format('select public.update_database(%L::jsonb,%L)',jsonb_build_object('database_id',:'crm'::jsonb->>'id','properties','[{"name":"Secret","type":"agentDelegate"}]'::jsonb),'computed')),'computed_property','computed properties rejected');
select is(tests.error_of(format('select public.add_rows(%L::jsonb,%L)',jsonb_build_object('database_id',:'crm'::jsonb->>'id','rows','[{"cells":{"Name":{"text":"Good"}}},{"cells":{"Missing":{"text":"Bad"}}}]'::jsonb),'batch')),'unknown_property','invalid row rolls back whole batch');
select is((select jsonb_array_length(data->'database'->'rows') from public.pages where id=(:'crm'::jsonb->>'id')),1,'no partial row persists');
select public.set_view(jsonb_build_object('database_id',:'crm'::jsonb->>'id','view','{"name":"Table","type":"table"}'::jsonb),'table');
select public.delete_view(jsonb_build_object('database_id',:'crm'::jsonb->>'id','name','Board'),'dropview');
select is(tests.error_of(format('select public.delete_view(%L::jsonb,%L)',jsonb_build_object('database_id',:'crm'::jsonb->>'id','name','Table'),'lastview')),'last_view','cannot remove last view');
select public.update_database(jsonb_build_object('database_id',:'crm'::jsonb->>'id','properties','[{"name":"Stage","rename":"Status"}]'::jsonb),'renameprop');
select is((select data->'database'->'properties'->1->>'name' from public.pages where id=(:'crm'::jsonb->>'id')),'Status','property rename preserves identity');
select public.delete_row(jsonb_build_object('database_id',:'crm'::jsonb->>'id','row_id',data->'database'->'rows'->0->>'id'),'deleterow') from public.pages where id=(:'crm'::jsonb->>'id');
select ok((select p.deleted_at is not null from public.pages d join public.pages p on p.id=d.data->'database'->'rows'->0->>'pageId' where d.id=(:'crm'::jsonb->>'id')),'row archive keeps row and page');
select is(coalesce(current_setting('app.ops_write',true),''),'','write capability cleared');
select tests.reset_role();
select * from finish();
rollback;
