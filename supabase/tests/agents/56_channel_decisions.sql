-- Only a verified service-role path may act as the linked person, using the existing decision rules.
begin;
select no_plan();
select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws,(:'f'::jsonb->>'owner') as owner,(:'f'::jsonb->>'viewer') as viewer,(:'f'::jsonb->>'agent') as agent,(:'f'::jsonb->>'agent_user') as au \gset
insert into public.agent_channel_links(workspace_id,user_id,channel,chat_id,from_id) values(:'ws',:'owner','telegram','201','201') returning id as link \gset
select tests.set_human(:'owner');
select public.create_agent_task('page_A','{"objective":"Test channel decisions"}',:'agent')->>'task_id' as task \gset
select tests.set_agent(:'au',:'agent');
select public.claim_task(:'task','channel-test')->>'run_id' as run \gset
select public.request_input(:'run','Continue?',array['approve','reject'],'plan')->>'approval_id' as approval \gset
select tests.reset_role();
select id as notice from public.channel_notices where approval_id=:'approval' \gset
select is((select count(*) from public.channel_notices where approval_id=:'approval'),1::bigint,'any agent request queues one owner notice');
select tests.set_human(:'owner');
select is(tests.sqlstate_of($q$select public.channel_decide('201','201',5,'x')$q$),'42501','person token cannot assert a Telegram click');
select tests.set_human(:'owner','oauth');
select is(tests.sqlstate_of($q$select public.channel_decide('201','201',5,'x')$q$),'42501','OAuth token cannot assert a click');
select tests.set_agent(:'au',:'agent');
select is(tests.sqlstate_of($q$select public.channel_decide('201','201',5,'x')$q$),'42501','agent token cannot assert a click');
select is(tests.sqlstate_of($q$select public.channel_answer('201','201',5,'yes')$q$),'42501','agent token cannot answer as a person');
select is(tests.sqlstate_of(format($q$select public.decide_approval(%L,'approve')$q$,:'approval')),'PT403','original agent-denial remains intact');
select tests.reset_role();
select tests.set_service();
select public.lease_channel_notices() as batch \gset
select is(jsonb_array_length(:'batch'::jsonb),1,'notice is leased');
select is(jsonb_array_length(public.lease_channel_notices()),0,'concurrent delivery cannot lease it again');
select public.complete_channel_notice(:'notice',(:'batch'::jsonb->0->>'lease')::uuid,5);
select is(tests.sqlstate_of(format($q$select public.channel_decide('201','999',5,%L)$q$,:'notice'||':approve')),'PT403','wrong sender cannot decide');
select is(tests.sqlstate_of(format($q$select public.channel_decide('201','201',6,%L)$q$,:'notice'||':approve')),'PT403','button must belong to delivered message');
select is(tests.sqlstate_of(format($q$select public.channel_decide('201','201',5,%L)$q$,:'notice'||':edit')),'PT403','edit stays in the app');
select is(public.channel_decide('201','201',5,:'notice'||':approve')->>'decision','approve','verified click decides');
select is(public.channel_decide('201','201',5,:'notice'||':reject')->>'decision','approve','second click returns the first decision');
select is((select decided_by from public.agent_approvals where id=:'approval')::text,:'owner','author is the linked human');
select is((select count(*) from public.agent_events where task_id=:'task' and type='approval.decided'),1::bigint,'one event reaches the agent');
select is((select body->>'source' from public.agent_activities where task_id=:'task' and body->>'approval_id'=:'approval' and author_type='human' and type='action'),'telegram','activity identifies Telegram');
select is(auth.role(),'service_role','impersonation does not escape the RPC');
select tests.reset_role();
select tests.set_agent(:'au',:'agent');
select public.request_input(:'run','Explain your choice',array['respond','ignore'])->>'approval_id' as question \gset
select tests.reset_role();
select id as qnotice from public.channel_notices where approval_id=:'question' \gset
update public.channel_notices set message_id=7,status='sent' where id=:'qnotice';
select tests.set_service();
select public.channel_answer('201','201',7,'A considered answer') as draft \gset
select is((select status from public.agent_approvals where id=:'question'),'pending','reply text alone never decides');
select is(tests.sqlstate_of($q$select public.channel_answer('201','201',7,'forwarded',true)$q$),'PT403','forwarded answer rejected');
select public.channel_answer_sent(:'qnotice',:'draft'::jsonb->>'nonce',8);
select is(public.channel_decide('201','201',8,:'qnotice'||':r:'||(:'draft'::jsonb->>'nonce'))->>'decision','respond','explicit confirmation sends stored answer');
select tests.reset_role();
-- Reuse the completed fixture approval to exercise server-side refusals without changing public decision rules.
update public.agent_approvals set status='pending',action='payment',kind='action' where id=:'approval';
select tests.set_service();
select is(tests.sqlstate_of(format($q$select public.channel_decide('201','201',5,%L)$q$,:'notice'||':approve')),'PT403','payment stays in app');
select tests.reset_role();
update public.agent_approvals set action=null,kind='plan',expires_at=now()-interval '1 second' where id=:'approval';
update public.channel_notices set channel_result=null where id=:'notice';
select tests.set_service();
select is(tests.sqlstate_of(format($q$select public.channel_decide('201','201',5,%L)$q$,:'notice'||':approve')),'PT410','expired button reuses original expiry checks');
select tests.reset_role();
update public.agent_channel_links set revoked_at=now() where id=:'link';
select tests.set_service();
select is(tests.sqlstate_of(format($q$select public.channel_decide('201','201',5,%L)$q$,:'notice'||':approve')),'PT403','revoked link cannot decide');
select tests.reset_role();
select tests.set_agent(:'au',:'agent');
select public.request_input(:'run','Asked while disconnected',array['approve','reject'],'plan')->>'approval_id' as missed \gset
select tests.reset_role();
insert into public.agent_channel_links(workspace_id,user_id,channel,chat_id,from_id) values(:'ws',:'owner','telegram','301','301');
select tests.set_service();
select public.channel_pending('301','301');
select is((select count(*) from public.channel_notices where approval_id=:'missed'),1::bigint,'pending recovers requests created before linking');
select * from finish();
rollback;
