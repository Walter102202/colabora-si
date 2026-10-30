-- An @agent mention in a person's comment creates a task on the page, delegated to the agent, with the comment as
-- its brief; an open task keeps the feedback path; agents, commenters who cannot edit, agents of other workspaces and
-- revoked agents create nothing; a failure keeps the comment and leaves an audit row.
begin;
select plan(18);

select tests.fixture() as f \gset
update public.agents set capabilities = '{"start":true}'::jsonb where id = (:'f'::jsonb->>'agent')::uuid;
-- Agent auth users carry principal_type in their app metadata, as agent-admin creates them.
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"principal_type":"agent"}'::jsonb
 where id = (:'f'::jsonb->>'agent_user')::uuid;
select '<span class="mention person-mention" data-user="' || (:'f'::jsonb->>'agent_user') || '">@Fixture Agent</span> '
       || 'Summarize this page in three bullets' as ask \gset

-- A. A person's mention on a page without a task.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.add_page_comment('page_A', :'ask', 'blk_a1') as c1 \gset
select tests.reset_role();
select ok(:'c1' ~ '^[0-9a-f]{32}$', 'the comment is stored and its id returned');
select is((select count(*) from public.agent_tasks where row_page_id = 'page_A' and request_kind is null), 1::bigint,
          'the mention creates one task on the page');
select is((select delegate_agent_id from public.agent_tasks where row_page_id = 'page_A'), (:'f'::jsonb->>'agent')::uuid,
          'delegated to the mentioned agent');
select is((select created_by from public.agent_tasks where row_page_id = 'page_A'), (:'f'::jsonb->>'owner')::uuid,
          'created by the person who commented');
select is((select b.objective from public.task_briefs b join public.agent_tasks t on t.id = b.task_id where t.row_page_id = 'page_A'),
          '@Fixture Agent Summarize this page in three bullets', 'the comment text is the objective');
select is((select b.policies->'from_comment'->>'comment_id' from public.task_briefs b join public.agent_tasks t on t.id = b.task_id
            where t.row_page_id = 'page_A'), :'c1', 'the brief remembers the comment');
select ok((select b.constraints from public.task_briefs b join public.agent_tasks t on t.id = b.task_id where t.row_page_id = 'page_A')
          like '%parent_id ' || :'c1' || ', block_id blk_a1%', 'the brief says where to reply');
select ok(exists (select 1 from public.agent_events e join public.agent_tasks t on t.id = e.task_id
                   where t.row_page_id = 'page_A' and e.type = 'task.start'), 'the agent is told to start');

-- B. A second mention while the task is open is feedback, as before.
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.add_page_comment('page_A', :'ask', 'blk_a1') as c2 \gset
select tests.reset_role();
select is((select count(*) from public.agent_tasks where row_page_id = 'page_A'), 1::bigint, 'no second task while one is open');
select is((select count(*) from public.agent_activities where body->>'comment_id' = :'c2' and body->>'signal' = 'feedback'), 1::bigint,
          'the open task gets the comment as feedback');

-- C. Mentions that create nothing.
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'other@agents.invalid', 'worker', 'page_B') as other \gset
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"principal_type":"agent"}'::jsonb
 where id = (:'other'::jsonb->>'user')::uuid;
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select public.add_page_comment('page_A1', '<span class="mention person-mention" data-user="' || (:'other'::jsonb->>'user')
                               || '">@other</span> do it');
select tests.reset_role();
select is((select count(*) from public.agent_tasks where row_page_id = 'page_A1'), 0::bigint, 'an agent''s mention never creates work');
select tests.make_user('guest@test.local') as guest \gset
insert into public.page_shares (page_id, user_id, level) values ('page_B', :'guest'::uuid, 'comment');
select tests.set_human(:'guest'::uuid);
select ok(public.add_page_comment('page_B', :'ask') ~ '^[0-9a-f]{32}$', 'a commenter without edit rights may comment');
select tests.reset_role();
select is((select count(*) from public.agent_tasks where row_page_id = 'page_B'), 0::bigint,
          'but the mention does not create a task for them');
insert into public.workspaces (name, owner_id) values ('Elsewhere', (:'f'::jsonb->>'owner')::uuid) returning id as ws2 \gset
select tests.make_agent(:'ws2'::uuid, 'far@agents.invalid', 'worker', 'page_B') as far \gset
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"principal_type":"agent"}'::jsonb
 where id = (:'far'::jsonb->>'user')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.add_page_comment('page_B', '<span class="mention person-mention" data-user="' || (:'far'::jsonb->>'user')
                               || '">@far</span> do it');
select tests.reset_role();
select is((select count(*) from public.agent_tasks where row_page_id = 'page_B'), 0::bigint, 'an agent of another workspace creates nothing');
update public.agents set revoked_at = now() where id = (:'other'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.add_page_comment('page_B', '<span class="mention person-mention" data-user="' || (:'other'::jsonb->>'user')
                               || '">@other</span> do it');
select tests.reset_role();
select is((select count(*) from public.agent_tasks where row_page_id = 'page_B'), 0::bigint, 'a revoked agent creates nothing');

-- D. A task that cannot be created keeps the comment.
update public.agents set monthly_budget_usd = -1 where id = (:'f'::jsonb->>'agent')::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
select public.add_page_comment('page_B', :'ask') as c3 \gset
select tests.reset_role();
select ok(exists (select 1 from public.pages p, jsonb_array_elements(p.data->'comments') c where p.id = 'page_B' and c->>'id' = :'c3'),
          'the comment is kept');
select is((select count(*) from public.agent_tasks where row_page_id = 'page_B'), 0::bigint, 'no task when the budget is spent');
select is((select target->>'error' from public.audit_events where action = 'mention.task_failed' and target->>'comment_id' = :'c3'),
          'budget_exceeded', 'the owner can see why');

select * from finish();
rollback;
