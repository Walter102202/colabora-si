begin;
select no_plan();
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid,'private_starter',null,'{"id":"private_starter","title":"Getting started","blocks":[]}');
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id)
  values ('private_starter',(:'f'::jsonb->>'ws')::uuid,(:'f'::jsonb->>'owner')::uuid,'private_starter');
select tests.make_user('connect-editor@test.local') as editor \gset
select tests.make_user('connect-other@test.local') as outsider \gset
insert into public.workspace_members(workspace_id,user_id,role) values ((:'f'::jsonb->>'ws')::uuid,:'editor','editor');
insert into public.workspaces(name,owner_id) values ('Other',:'outsider') returning id as other_ws \gset
select tests.make_page(:'other_ws','other_page');
select tests.make_agent(:'other_ws','connect-other-agent@agents.invalid','worker','other_page') as other_agent \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid,'connect-second@agents.invalid','worker','page_A') as second \gset
create temporary table calls(name text,sql text);
insert into calls values
 ('workspaces','select public.connect_workspaces()'),
 ('claim',format('select public.connect_claim(%L,%L,%L,%L)',:'f'::jsonb->>'ws','auth-1','client-1',:'f'::jsonb->>'agent')),
 ('finish',format('select public.connect_agent_finish(%L,%L)',:'f'::jsonb->>'ws',:'f'::jsonb->>'agent')),
 ('approved',format('select public.connect_agent_approved(%L)',:'f'::jsonb->>'agent')),
 ('read',$q$select public.record_agent_read('page_A')$q$);
grant select on calls to anon,authenticated;
select tests.set_anon();
select is(tests.sqlstate_of(sql),'42501',name||' denies anon') from calls;
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is(tests.sqlstate_of(sql),'PT403',name||' denies viewer') from calls where name in ('claim','finish');
select is((select count(*) from public.connect_workspaces() where id=(:'f'::jsonb->>'ws')::uuid),0::bigint,'viewer has no editable workspace');
select tests.reset_role();
select tests.set_human(:'outsider');
select is(tests.sqlstate_of(sql),'PT403',name||' denies outsider') from calls where name in ('claim','finish');
select is((select count(*) from public.connect_workspaces() where id=(:'f'::jsonb->>'ws')::uuid),0::bigint,'other workspace is not listed');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid,'oauth-client');
select is(tests.sqlstate_of(sql),'PT403',name||' denies OAuth session') from calls where name<>'read';
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of(sql),'PT403',name||' denies agent') from calls where name<>'read';
select tests.reset_role();
select tests.set_human(:'editor');
select is(tests.sqlstate_of(sql),'PT403','editor cannot finish another sponsor agent') from calls where name='finish';
select tests.reset_role();
update public.agents set is_platform=true where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(sql),'PT403','platform agent rejected') from calls where name='finish';
select tests.reset_role();
update public.agents set is_platform=false,revoked_at=now() where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(sql),'PT403','revoked agent rejected') from calls where name='finish';
select tests.reset_role();
update public.agents set revoked_at=null,status='disabled' where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(sql),'PT403','disabled agent rejected') from calls where name='finish';
select tests.reset_role();
update public.agents set status='enabled' where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(tests.sqlstate_of(format('select public.connect_agent_finish(%L,%L)',:'f'::jsonb->>'ws',:'other_agent'::jsonb->>'agent')),'PT403','foreign workspace agent rejected');
select is(tests.error_of(format('select public.connect_agent_approved(%L)',:'f'::jsonb->>'agent')),'not_found','approval needs connection');
select is(tests.error_of(format('select public.connect_claim(%L,%L,null,%L)',:'f'::jsonb->>'ws','unknown',:'f'::jsonb->>'agent')),'not_found','missing claim without client rejected');
select public.connect_agent_finish((:'f'::jsonb->>'ws')::uuid,(:'f'::jsonb->>'agent')::uuid,'client-1','auth-1') as first \gset
select public.connect_agent_finish((:'f'::jsonb->>'ws')::uuid,(:'second'::jsonb->>'agent')::uuid) as second_connection \gset
select is(:'first'::jsonb->>'page_id',:'second_connection'::jsonb->>'page_id','agents share starter page');
select isnt(:'first'::jsonb->>'page_id','private_starter','private default never becomes shared');
select ok((select root_order ? (:'first'::jsonb->>'page_id') from public.workspaces where id=(:'f'::jsonb->>'ws')::uuid),'starter in root order');
select is((select count(*) from public.private_pages where page_id=:'first'::jsonb->>'page_id'),0::bigint,'starter is not private');
select is((select data->>'title' from public.pages where id=:'first'::jsonb->>'page_id'),'Getting started','starter title');
select is((select jsonb_array_length(data->'blocks') from public.pages where id=:'first'::jsonb->>'page_id'),4,'starter content');
select ok((select scopes @> array['read','write','comment'] and cardinality(scopes)=3 and inherit from public.agent_grants where agent_id=(:'f'::jsonb->>'agent')::uuid and page_id=:'first'::jsonb->>'page_id'),'complete inherited grant');
select public.connect_agent_approved((:'f'::jsonb->>'agent')::uuid);
select ok((select approved_at is not null and verified_at is null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'approval does not verify');
select is(public.connect_claim((:'f'::jsonb->>'ws')::uuid,'auth-1','client-1',gen_random_uuid()),(:'f'::jsonb->>'agent')::uuid,'client reuses live agent');
select is(public.connect_claim((:'f'::jsonb->>'ws')::uuid,'auth-1',null,gen_random_uuid()),(:'f'::jsonb->>'agent')::uuid,'authorization retry reuses claim');
select is(tests.sqlstate_of('insert into public.agent_connections default values'),'42501','direct insert denied');
select is(tests.sqlstate_of('update public.agent_connections set verified_at=now()'),'42501','direct update denied');
select is(tests.sqlstate_of('delete from public.agent_connections'),'42501','direct delete denied');
select public.record_agent_read(:'first'::jsonb->>'page_id');
select ok((select verified_at is null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'person read does not verify');
select tests.reset_role();
select tests.set_human(:'editor');
select is(tests.sqlstate_of(format('select public.connect_claim(%L,%L,%L,%L)',:'f'::jsonb->>'ws','auth-1','client-1',:'f'::jsonb->>'agent')),'PT403','claim belongs to its person');
select is((select count(*) from public.agent_connections),2::bigint,'member sees connections');
select tests.reset_role();
select tests.set_human(:'outsider');
select is((select count(*) from public.agent_connections),0::bigint,'outsider sees no connection');
select tests.reset_role();
select tests.set_agent((:'other_agent'::jsonb->>'user')::uuid,(:'other_agent'::jsonb->>'agent')::uuid);
select public.record_agent_read(:'first'::jsonb->>'page_id');
select tests.reset_role();
select ok((select verified_at is null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'other agent cannot verify connection');
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.record_agent_read('page_A');
select tests.reset_role();
select ok((select verified_at is null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'other page does not verify');
update public.agents set revoked_at=now() where id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.record_agent_read(:'first'::jsonb->>'page_id');
select tests.reset_role();
select ok((select verified_at is null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'revoked agent does not verify');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select is(public.connect_claim((:'f'::jsonb->>'ws')::uuid,'auth-2','client-1',(:'second'::jsonb->>'agent')::uuid),(:'second'::jsonb->>'agent')::uuid,'new authorization does not reuse revoked agent');
select tests.reset_role();
update public.agents set revoked_at=null where id=(:'f'::jsonb->>'agent')::uuid;
update public.agent_grants set revoked_at=now() where agent_id=(:'f'::jsonb->>'agent')::uuid and page_id=:'first'::jsonb->>'page_id';
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.record_agent_read(:'first'::jsonb->>'page_id');
select tests.reset_role();
select ok((select verified_at is null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'read without grant does not verify');
update public.agent_grants set revoked_at=null where agent_id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.record_agent_read(:'first'::jsonb->>'page_id');
select tests.reset_role();
select ok((select verified_at is not null from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'agent reading starter verifies');
update public.agent_connections set verified_at='2026-01-01' where agent_id=(:'f'::jsonb->>'agent')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid,(:'f'::jsonb->>'agent')::uuid);
select public.record_agent_read(:'first'::jsonb->>'page_id');
select tests.reset_role();
select is((select verified_at from public.agent_connections where agent_id=(:'f'::jsonb->>'agent')::uuid),'2026-01-01'::timestamptz,'first verification preserved');
update public.agents set sponsor_user_id=:'editor' where id=(:'second'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select lives_ok(format('select public.connect_agent_finish(%L,%L)',:'f'::jsonb->>'ws',:'second'::jsonb->>'agent'),'owner may finish another sponsor agent');
select public.archive_page(jsonb_build_object('page_id',:'first'::jsonb->>'page_id'),'archive-starter');
select public.connect_agent_finish((:'f'::jsonb->>'ws')::uuid,(:'f'::jsonb->>'agent')::uuid) as replacement \gset
select isnt(:'replacement'::jsonb->>'page_id',:'first'::jsonb->>'page_id','archived starter not reused');
select tests.reset_role();
-- A fresh workspace uses its default root instead of creating another page.
select tests.set_human(:'outsider');
insert into public.workspace_members(workspace_id,user_id,role) values (:'other_ws',:'outsider','owner');
select public.create_page(jsonb_build_object('workspace_id',:'other_ws','title','Getting started'),'default-starter') as default_page \gset
select is(public.connect_agent_finish(:'other_ws',(:'other_agent'::jsonb->>'agent')::uuid)->>'page_id',:'default_page'::jsonb->>'id','default root reused');
select tests.reset_role();
select * from finish();
rollback;
