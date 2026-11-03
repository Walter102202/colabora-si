-- Work and conversation limits are independent and preserve external parallelism.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner \gset
select tests.make_user('concurrency-platform@agents.invalid') as pu \gset
select tests.set_service();
select public.ensure_platform_agent(:'ws', :'owner', :'pu')->>'agent_id' as platform \gset
select tests.reset_role();
select is((select max_active_work_runs from public.agents where id=:'platform'),1,'platform work default is one');
select is((select max_active_request_runs from public.agents where id=:'platform'),3,'platform request default is three');
select tests.make_agent(:'ws','concurrency-external@agents.invalid','worker','page_A') as external \gset
select is((select max_active_work_runs from public.agents where id=(:'external'::jsonb->>'agent')::uuid),null::integer,'external work is unlimited');
select is((select max_active_request_runs from public.agents where id=(:'external'::jsonb->>'agent')::uuid),null::integer,'external requests are unlimited');
select tests.set_human(:'owner');
select public.create_agent_task('page_A','{"objective":"First work"}',:'platform')->>'task_id' as first \gset
select public.create_agent_task('page_B','{"objective":"Second work"}',:'platform')->>'task_id' as second \gset
select is(tests.error_of(format('select public.claim_task(%L)',:'first')),'agent_disabled','a person cannot claim an agent run');
select public.post_agent_message(:'ws','Help with this work',gen_random_uuid());
select tests.reset_role();
select id as chat from public.agent_tasks where workspace_id=:'ws' and request_kind='assist' and owner_user_id=:'owner' \gset
select tests.set_agent(:'pu',:'platform');
select public.claim_task(:'first','custom') as first_claim \gset
select is(:'first_claim'::jsonb->>'task_id',:'first','first work claim succeeds');
select is(tests.sqlstate_of(format('select public.claim_task(%L)',:'second')),'PT409','second work claim conflicts');
select is(tests.error_of(format('select public.claim_task(%L)',:'second')),'agent_busy','second work claim reports capacity');
select tests.detail_of(format('select public.claim_task(%L)',:'second'))::jsonb as detail \gset
select is(:'detail'::jsonb->>'limit','1','busy detail gives the limit');
select is(:'detail'::jsonb->'active_task_ids',jsonb_build_array(:'first'),'busy detail names the active task');
select is(public.claim_task(:'chat','custom')->>'task_id',:'chat','conversation can run beside active work');
select public.end_run((:'first_claim'::jsonb->>'run_id')::uuid,'completed');
select is(public.claim_task(:'second','custom')->>'task_id',:'second','ending a run immediately frees work capacity');
select tests.reset_role();
select tests.make_page(:'ws','concurrency-ext1','page_A');
select tests.make_page(:'ws','concurrency-ext2','page_A');
select tests.set_human(:'owner');
select public.create_agent_task('concurrency-ext1','{"objective":"External first"}',(:'external'::jsonb->>'agent')::uuid)->>'task_id' as ext1 \gset
select public.create_agent_task('concurrency-ext2','{"objective":"External second"}',(:'external'::jsonb->>'agent')::uuid)->>'task_id' as ext2 \gset
select tests.reset_role();
select tests.set_agent((:'external'::jsonb->>'user')::uuid,(:'external'::jsonb->>'agent')::uuid);
select is(public.claim_task(:'ext1','custom')->>'task_id',:'ext1','external first work claim succeeds');
select is(public.claim_task(:'ext2','custom')->>'task_id',:'ext2','external second work claim succeeds in parallel');
select tests.reset_role();
-- A second person has an independent conversation with the same platform agent.
update public.agents set max_active_request_runs=1 where id=:'platform';
select tests.set_human((:'f'::jsonb->>'viewer')::uuid);
select public.post_agent_message(:'ws','Help me too',gen_random_uuid());
select tests.reset_role();
select id as chat2 from public.agent_tasks where workspace_id=:'ws' and request_kind='assist' and owner_user_id=(:'f'::jsonb->>'viewer')::uuid \gset
select tests.set_agent(:'pu',:'platform');
select is(tests.error_of(format('select public.claim_task(%L)',:'chat2')),'agent_busy','request limit rejects a second conversation');
select tests.reset_role();
select * from finish();
rollback;
