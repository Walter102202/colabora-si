-- Trama sees only the person's readable, actionable pending reviews.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer \gset
select tests.make_user('pending-editor@test.local') as editor \gset
insert into public.workspace_members(workspace_id,user_id,role) values(:'ws',:'editor','editor');
select tests.set_human(:'owner');
select public.create_agent_task('page_A','{"objective":"Readable task"}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as task \gset
select public.create_agent_task('page_B','{"objective":"Private task"}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as hidden_task \gset
select tests.reset_role();
insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id) values('page_B',:'ws',:'viewer','page_B');
insert into public.lessons(workspace_id,body,scope,source_kind,source_task_id,proposed_by_type,proposed_by,created_at)
values(:'ws',repeat('L',200),'workspace','feedback',:'task','agent',(:'f'::jsonb->>'agent')::uuid,now()-interval '1 day'),
      (:'ws','Private lesson','workspace','feedback',:'hidden_task','agent',(:'f'::jsonb->>'agent')::uuid,now());
insert into public.lessons(workspace_id,body,scope,source_kind,status,proposed_by_type,proposed_by)
select :'ws',s,'workspace','person',s,'human',:'owner' from unnest(array['accepted','dismissed']) s;
insert into public.page_discrepancies(workspace_id,page_id,source_ids,summary,status,created_at)
values(:'ws','page_A','{}',repeat('D',200),'open',now()-interval '1 day'),
      (:'ws','page_B','{}','Private difference','open',now()),
      (:'ws','page_A1','{}','Resolved difference','resolved',now());
select tests.set_human(:'owner');
select is((select count(*) from public.lessons where status='proposed'),1::bigint,'browser cannot read another person private task lesson');
select is((select count(*) from public.page_discrepancies where status='open'),1::bigint,'browser cannot read another person private page difference');
select tests.reset_role();
select tests.set_human(:'viewer');
select is((select count(*) from public.lessons where status='proposed'),0::bigint,'browser hides proposals a viewer cannot decide');
select is((select count(*) from public.lessons where status='accepted'),1::bigint,'viewer retains accepted lesson browsing');
select tests.reset_role();
select private.person_to_review(:'ws',:'owner') as pending \gset
select is(:'pending'::jsonb->>'lessons_total','1','only proposed readable lessons count');
select is(:'pending'::jsonb#>>'{lessons,0,path}','/p/page_A?task='||:'task','lesson links to its task');
select is(:'pending'::jsonb#>>'{lessons,0,task}','Page A','lesson carries the task name');
select is(length(:'pending'::jsonb#>>'{lessons,0,text}'),160,'lesson preview is bounded');
select is(:'pending'::jsonb->>'differences_total','1','only open readable differences count');
select is(:'pending'::jsonb#>>'{differences,0,path}','/p/page_A','difference links to its page');
select is(length(:'pending'::jsonb#>>'{differences,0,text}'),160,'difference preview is bounded');
select is(private.person_to_review(:'ws',:'viewer')->>'lessons_total','0','viewers cannot decide lessons');
select is(private.person_to_review(:'ws',:'editor')->>'lessons_total','1','editor membership is checked for the supplied person');
select is(private.person_to_review(gen_random_uuid(),:'owner'),'{"lessons":[],"lessons_total":0,"differences":[],"differences_total":0}'::jsonb,'another workspace returns no reviews');
select is(private.person_to_review(:'ws',gen_random_uuid()),'{"lessons":[],"lessons_total":0,"differences":[],"differences_total":0}'::jsonb,'outsiders receive no reviews');
insert into public.lessons(workspace_id,body,scope,source_kind,proposed_by_type,proposed_by,created_at)
select :'ws','Standalone '||n,'workspace','person','human',:'owner',now()+n*interval '1 second' from generate_series(1,6) n;
select tests.make_page(:'ws','pending-'||n) from generate_series(1,6) n;
insert into public.page_discrepancies(workspace_id,page_id,source_ids,summary,created_at)
select :'ws','pending-'||n,'{}','Difference '||n,now()+n*interval '1 second' from generate_series(1,6) n;
select private.person_to_review(:'ws',:'owner') as pending \gset
select is(jsonb_array_length(:'pending'::jsonb->'lessons'),5,'at most five lessons');
select is(:'pending'::jsonb->>'lessons_total','7','lesson total includes the remainder');
select is(:'pending'::jsonb#>>'{lessons,1,path}','/','standalone lesson links Home');
select is(:'pending'::jsonb#>>'{lessons,4,text}','Standalone 4','oldest lessons come first');
select is(jsonb_array_length(:'pending'::jsonb->'differences'),5,'at most five differences');
select is(:'pending'::jsonb->>'differences_total','7','difference total includes the remainder');
select is(:'pending'::jsonb#>>'{differences,4,text}','Difference 4','oldest differences come first');
select ok(not has_function_privilege('anon','private.person_to_review(uuid,uuid)','execute'),'anon cannot call helper');
select ok(not has_function_privilege('authenticated','private.person_to_review(uuid,uuid)','execute'),'authenticated cannot call helper');
select tests.make_agent(:'ws','pending-trama@test.invalid','lead','page_A') as pl \gset
update public.agents set is_platform=true where id=(:'pl'::jsonb->>'agent')::uuid;
select tests.set_human(:'owner');
select public.post_agent_message(:'ws','What is pending?',gen_random_uuid());
select tests.reset_role();
select id as request from public.agent_tasks where workspace_id=:'ws' and request_kind='assist' and owner_user_id=:'owner' \gset
select tests.set_agent((:'pl'::jsonb->>'user')::uuid,(:'pl'::jsonb->>'agent')::uuid);
select public.claim_task(:'request','pending-test');
select is(public.assist_request_context(:'request')->'to_review',:'pending'::jsonb,'Trama context uses the person access, not the agent membership');
select tests.reset_role();
select * from finish();
rollback;
