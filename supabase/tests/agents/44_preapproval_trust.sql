begin;
select plan(20);
select tests.fixture() as f \gset
select tests.make_page((:'f'::jsonb->>'ws')::uuid, p, 'page_A') from unnest(array['trust_P','trust_C','trust_bad','trust_bad_if']) p;
select tests.make_agent((:'f'::jsonb->>'ws')::uuid, 'agent+trustlead@agents.invalid', 'lead', 'page_A') as lead \gset
select tests.make_user('trust-editor@test.local') as editor \gset
insert into public.workspace_members (workspace_id,user_id,role) values ((:'f'::jsonb->>'ws')::uuid, :'editor'::uuid, 'editor');
select tests.set_agent((:'lead'::jsonb->>'user')::uuid, (:'lead'::jsonb->>'agent')::uuid);
select public.create_agent_task('trust_P','{"objective":"Parent"}',(:'lead'::jsonb->>'agent')::uuid)->>'task_id' as parent \gset
select public.claim_task(:'parent'::uuid,'codex')->>'run_id' as run \gset
select public.create_subtask(:'parent'::uuid,'trust_C','{"objective":"Child"}',(:'f'::jsonb->>'agent')::uuid)->>'task_id' as child \gset
select is(tests.error_of(format('select public.create_agent_task(%L,%L::jsonb,%L::uuid)', 'trust_bad','{"objective":"Bad","policies":{"preapproved":["deploy"]}}',:'lead'::jsonb->>'agent')), 'owner_required', 'an agent cannot create unconditional preapprovals');
select is(tests.error_of(format('select public.create_agent_task(%L,%L::jsonb,%L::uuid)', 'trust_bad_if','{"objective":"Bad","policies":{"preapproved_if":{"deploy":["ci_green"]}}}',:'lead'::jsonb->>'agent')), 'owner_required', 'an agent cannot create conditional preapprovals');
select tests.reset_role();
-- Existing untrusted entries are possible in databases upgraded from earlier versions.
update public.task_briefs set policies='{"preapproved":["deploy"],"preapproved_if":{"db.drop":["ci_green"]},"lease_minutes":90}', preapproved_trusted=false
 where task_id=:'parent'::uuid;
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
reset role;
select public.update_brief(:'parent'::uuid,'{"policies":{"preapproved":["deploy"],"preapproved_if":{"db.drop":["ci_green"],"git.merge":["review_approved","ci_green"]},"lease_minutes":90}}');
select is(private.action_allowed('deploy',:'parent'::uuid),null,'enabling merge never trusts the legacy unconditional sibling');
select is((select private.policy_action_trusted(b,'db.drop',true) from public.task_briefs b join public.agent_tasks t on t.id=b.task_id and t.brief_version=b.version where t.id=:'parent'::uuid),false,'enabling merge never trusts another conditional action');
select is(public.task_autonomy(:'parent'::uuid)->'merge_rule'->>'enabled','true','the server reports the explicitly trusted merge rule');
select public.set_merge_rule(:'parent'::uuid,null);
select is(private.action_allowed('deploy',:'parent'::uuid),null,'disabling merge cannot trust an unconditional sibling');
select is((select private.policy_action_trusted(b,'db.drop',true) from public.task_briefs b join public.agent_tasks t on t.id=b.task_id and t.brief_version=b.version where t.id=:'parent'::uuid),false,'disabling merge cannot trust a conditional sibling');
select public.update_brief(:'parent'::uuid,'{"policies":{"preapproved":["deploy","send_email"],"preapproved_if":{"db.drop":["ci_green"]},"lease_minutes":90}}');
select is(private.action_allowed('send_email',:'parent'::uuid),'brief','only the unconditional entry the owner added is trusted');
select is(private.action_allowed('deploy',:'parent'::uuid),null,'adding an unconditional entry does not trust an unchanged sibling');
select is((select private.policy_action_trusted(b,'db.drop',true) from public.task_briefs b join public.agent_tasks t on t.id=b.task_id and t.brief_version=b.version where t.id=:'parent'::uuid),false,'editing the unconditional list cannot trust conditional entries');
select tests.reset_role();
update public.task_briefs b set policies=jsonb_set(policies,'{preapproved_if,git.merge}','["review_approved","ci_green"]')
 where task_id=:'parent'::uuid and version=(select brief_version from public.agent_tasks where id=:'parent'::uuid);
select tests.set_human((:'f'::jsonb->>'owner')::uuid);
reset role;
select is(public.task_autonomy(:'parent'::uuid)->'merge_rule'->>'enabled','false','raw untrusted JSON is not shown as an enabled rule');
select public.set_merge_rule(:'parent'::uuid,array['review_approved','ci_green']);
select is(public.task_autonomy(:'parent'::uuid)->'merge_rule'->>'enabled','true','explicit narrow activation trusts only the named action even if raw JSON already matched');
select is((select policies->>'lease_minutes' from public.task_briefs where task_id=:'parent'::uuid order by version desc limit 1),'90','the narrow RPC preserves unrelated policies');
select is(private.action_allowed('deploy',:'parent'::uuid),null,'the narrow RPC never adopts legacy unconditional entries');
select tests.reset_role();
select tests.set_human(:'editor'::uuid);
select is(tests.error_of(format('select public.set_merge_rule(%L::uuid,array[%L,%L])',:'parent','review_approved','ci_green')),'owner_required','an editor cannot set the merge rule');
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'parent','{"policies":{"preapproved":["deploy"]}}')),'owner_required','an editor cannot write preapproved through update_brief');
select tests.reset_role();
select tests.set_agent((:'lead'::jsonb->>'user')::uuid,(:'lead'::jsonb->>'agent')::uuid);
select is(tests.error_of(format('select public.update_brief(%L::uuid,%L::jsonb)',:'child','{"policies":{"preapproved_if":{"deploy":["ci_green"]}}}')),'owner_required','a Lead cannot write conditional policies on a child');
select is(tests.error_of(format('select public.set_merge_rule(%L::uuid,array[%L,%L])',:'parent','review_approved','ci_green')),'owner_required','an agent cannot use the narrow RPC');
select tests.reset_role();
insert into public.agent_oauth_links(user_id,client_id,as_human) values ((:'f'::jsonb->>'owner')::uuid,'trust-chat',true);
select tests.set_human((:'f'::jsonb->>'owner')::uuid,'trust-chat');
select is(tests.error_of(format('select public.set_merge_rule(%L::uuid,null)',:'parent')),'direct_session_required','chat cannot disable or enable a rule');
select tests.reset_role();
set local role anon;
select is(tests.sqlstate_of(format('select public.set_merge_rule(%L::uuid,null)',:'parent')),'42501','anonymous callers cannot set the rule');
select tests.reset_role();
select * from finish();
rollback;
