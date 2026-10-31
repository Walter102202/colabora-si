-- Context package: lessons reach an agent only for tasks inside their scope, decisions follow the page grants, every
-- item says why it is there, and a delivered lesson can be cited.
begin;
select plan(31);

select tests.fixture() as f \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+lead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+other@agents.invalid', 'worker', 'page_B') as other \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_DB', 'page_A',
  '{"id":"page_DB","title":"Reports","parentId":"page_A","blocks":[],"database":{"properties":[],"rows":[],"views":[]}}'::jsonb);
select tests.make_page((:'f'::jsonb->>'ws')::uuid, r, 'page_DB') from unnest(array['page_R1','page_R2','page_R3','page_R4','page_R5','page_R6']) r;
select tests.make_page((:'f'::jsonb->>'ws')::uuid, 'page_X');

-- A person-written lesson for each scope, from a corrected task.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_R1', '{"objective":"Write the weekly client report"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t1 \gset
select public.create_lesson((:'f'::jsonb->>'ws')::uuid, 'Client reports use dates as DD/MM/YYYY', 'Use 30/10/2026', 'page', 'page_DB') ->> 'lesson_id' as db \gset
select public.create_lesson((:'f'::jsonb->>'ws')::uuid, 'Sign every message with the team name', '', 'workspace') ->> 'lesson_id' as wk \gset
select public.create_lesson((:'f'::jsonb->>'ws')::uuid, 'Quote the price in USD', '', 'page', 'page_X') ->> 'lesson_id' as far \gset
select public.create_lesson((:'f'::jsonb->>'ws')::uuid, 'This project ships on Fridays', '', 'context', null, :'t1'::uuid) ->> 'lesson_id' as ctx \gset
select public.create_lesson((:'f'::jsonb->>'ws')::uuid, 'Not delivered back to its source', '', 'page', 'page_DB', :'t1'::uuid) ->> 'lesson_id' as own \gset
select public.create_agent_task('page_R2', '{"objective":"Write the monthly client report","done_when":[{"id":"c1","text":"Dates are right"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t2 \gset
select public.create_lesson((:'f'::jsonb->>'ws')::uuid, 'Retired lesson', '', 'page', 'page_DB') ->> 'lesson_id' as old \gset
select public.retire_lesson(:'old'::uuid);
select tests.reset_role();

-- A. What applies, with its reason.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t2'::uuid, 'codex') ->> 'run_id' as r2 \gset
select public.task_context(:'r2'::uuid) as p \gset
select is((select count(*) from jsonb_array_elements(:'p'::jsonb->'lessons')), 3::bigint, 'the two of the database and the workspace one apply');
select is(:'p'::jsonb->'lessons'->0->>'id', :'db', 'the narrowest scope comes first, the one sharing words before the other');
select ok(:'p'::jsonb->'lessons'->0->>'why' like 'Accepted for "Reports", which holds this task%', 'it says why');
select ok(:'p'::jsonb->'lessons'->0->>'why' like '%shares with your brief: client%', 'and which words of the brief it shares');
select is(:'p'::jsonb->'lessons'->2->>'id', :'wk', 'then the workspace');
select is(:'p'::jsonb->'lessons'->0->>'example', 'Use 30/10/2026', 'it carries its example');
select is(public.task_context(:'r2'::uuid)->'lessons', :'p'::jsonb->'lessons', 'asking again answers the same');
select tests.reset_role();
select is((select count(*) from public.lesson_deliveries where run_id = :'r2'::uuid), 3::bigint, 'each delivery is recorded once');
select is((select count(*) from public.agent_activities where run_id = :'r2'::uuid and body->>'op' = 'context_package'), 1::bigint, 'one line in the history');

-- B. Scope is the boundary: no grant on the page above the task is needed, and nothing outside it arrives.
select is((select count(*) from public.agent_grants where agent_id = (:'f'::jsonb->>'agent')::uuid and page_id = 'page_DB'), 0::bigint, 'the agent holds no grant on the database itself');
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_R4', format('{"objective":"Same project","done_when":[]}')::jsonb, (:'other'::jsonb->>'agent')::uuid) ->> 'task_id' as t4 \gset
select tests.reset_role();
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select public.claim_task(:'t4'::uuid, 'codex') ->> 'run_id' as r4 \gset
select ok((public.task_context(:'r4'::uuid)->'lessons') @> format('[{"id":"%s"}]', :'db')::jsonb, 'a delegate inside the scope gets the lesson');
select is(position('holds this task' in (public.task_context(:'r4'::uuid)->'lessons'->0->>'why')) > 0 and position('Reports' in (public.task_context(:'r4'::uuid)->'lessons'->0->>'why')) = 0, true,
          'without the title of a page it cannot read');
select is(tests.error_of(format('select public.task_context(%L::uuid)', :'r2')), 'forbidden', 'nobody reads the context of another run');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is((select count(*) from jsonb_array_elements(public.task_context(:'r2'::uuid)->'lessons') l where l->>'id' in (:'far', :'ctx', :'old')), 0::bigint,
          'another page, another project and a retired lesson stay out');
select public.claim_task(:'t1'::uuid, 'codex') ->> 'run_id' as r1 \gset
select ok(not (public.task_context(:'r1'::uuid)->'lessons') @> format('[{"id":"%s"}]', :'own')::jsonb, 'a task does not get back the lesson it produced');
select tests.reset_role();
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_R6', '{"objective":"Another step of the same project"}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as t6 \gset
select tests.reset_role();
update public.agent_tasks set context_id = (select context_id from public.agent_tasks where id = :'t1'::uuid) where id = :'t6'::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.claim_task(:'t6'::uuid, 'codex') ->> 'run_id' as r6 \gset
select ok((select l->>'why' like 'Accepted for this project%' from jsonb_array_elements(public.task_context(:'r6'::uuid)->'lessons') l where l->>'id' = :'ctx'), 'a project lesson reaches another task of that project');
select tests.reset_role();

-- C. Citing.
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.cite_lesson(%L::uuid, %L::uuid)', :'r2', :'far')), 'lesson_not_delivered', 'only a delivered lesson can be cited');
select public.cite_lesson(:'r2'::uuid, :'db'::uuid, 'Used DD/MM/YYYY');
select public.cite_lesson(:'r2'::uuid, :'db'::uuid);
select tests.reset_role();
select is((select cite_note from public.lesson_deliveries where run_id = :'r2'::uuid and lesson_id = :'db'::uuid), 'Used DD/MM/YYYY', 'the citation is kept');
select is((select count(*) from public.agent_activities where run_id = :'r2'::uuid and body->>'op' = 'cite_lesson'), 1::bigint, 'and shows once in the history');
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.cite_lesson(%L::uuid, %L::uuid)', :'r2', :'db')), 'forbidden', 'nobody cites on another run');
select is((select count(*) from public.lesson_deliveries), 0::bigint, 'an agent reads no delivery from the table');
select tests.reset_role();

-- D. Decisions: ancestors and readable tasks, the rest counted but not shown.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.create_agent_task('page_A1', '{"objective":"Lead the launch","decisions":[{"at":"2026-10-30T10:00:00Z","by":"Ana","text":"Launch in Chile first"}]}'::jsonb, (:'lead'::jsonb->>'agent')::uuid) ->> 'task_id' as parent \gset
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.claim_task(:'parent'::uuid, 'claude_code') ->> 'run_id' as lr \gset
select public.create_subtask(:'parent'::uuid, 'page_R3', '{"objective":"Secret sibling","done_when":[{"id":"c","text":"x","check":"lead"}],"decisions":[{"at":"2026-10-30T11:00:00Z","by":"Lead","text":"Keep the price private"}]}'::jsonb, (:'f'::jsonb->>'agent')::uuid) ->> 'task_id' as sib \gset
select public.create_subtask(:'parent'::uuid, 'page_R5', '{"objective":"Open sibling","done_when":[{"id":"c","text":"x","check":"lead"}]}'::jsonb, (:'other'::jsonb->>'agent')::uuid) ->> 'task_id' as sub \gset
select tests.reset_role();
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select public.claim_task(:'sub'::uuid, 'codex') ->> 'run_id' as sr \gset
select public.task_context(:'sr'::uuid) as q \gset
select is(:'q'::jsonb->'decisions'->0->>'text', 'Launch in Chile first', 'the decisions above a task bind it');
select ok(:'q'::jsonb->'decisions'->0->>'why' like 'Decided on "%", above your task', 'with their reason');
select is(jsonb_array_length(:'q'::jsonb->'decisions'), 1, 'a sibling it cannot read stays out');
select is(:'q'::jsonb->'withheld'->>'decisions', '1', 'and is counted');
select tests.reset_role();
insert into public.agent_grants (workspace_id, agent_id, page_id, scopes, inherit, granted_by)
values ((:'f'::jsonb->>'ws')::uuid, (:'other'::jsonb->>'agent')::uuid, 'page_R3', array['read'], false, (:'f'::jsonb->>'owner')::uuid);
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is(jsonb_array_length(public.task_context(:'sr'::uuid)->'decisions'), 2, 'with a read grant it arrives');
select tests.reset_role();
update public.agent_tasks set state = 'cancelled' where id = :'sib'::uuid;
select tests.set_agent((:'other'::jsonb->>'user')::uuid, (:'other'::jsonb->>'agent')::uuid);
select is(jsonb_array_length(public.task_context(:'sr'::uuid)->'decisions'), 1, 'a cancelled task decides nothing');
select tests.reset_role();

-- E. The numbers.
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select is((select (s->>'delivered')::int from jsonb_array_elements(public.lesson_stats((:'f'::jsonb->>'ws')::uuid)) s where s->>'lesson_id' = :'db'), 5, 'deliveries are counted by run');
select is((select (s->>'cited')::int from jsonb_array_elements(public.lesson_stats((:'f'::jsonb->>'ws')::uuid)) s where s->>'lesson_id' = :'db'), 1, 'citations too');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.lesson_stats(%L::uuid)', :'f'::jsonb->>'ws')), 'not_found', 'the numbers are for people');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.task_context(%L::uuid)', :'r2')), '42501', 'a signed-out caller cannot call it');
select tests.reset_role();

select * from finish();
rollback;
