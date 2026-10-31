-- Voice: who reaches the model, what stops it before any cost, and why a transcript never acts.
begin;
select plan(59);

select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer,
       (:'f'::jsonb->>'agent') as agent, (:'f'::jsonb->>'agent_user') as agent_user \gset
select tests.make_user('outsider@test.local') as outsider \gset
insert into public.agent_oauth_links (user_id, client_id, as_human) values (:'owner'::uuid, 'chat-client', true);

-- A. No platform agent, no voice.
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT409', 'no platform agent, no voice');
select tests.reset_role();

select tests.make_agent(:'ws'::uuid, 'agent+platform@agents.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform = true, sponsor_user_id = :'owner'::uuid, rate_limit_per_min = 1000 where id = :'pa'::uuid;

-- B. Who may spend.
select tests.set_human(:'owner'::uuid);
select ok((public.voice_reserve(:'ws'::uuid, 5000, 240044))->>'clip_id' is not null, 'a member reserves');
select is((select count(*) from public.voice_clips), 1::bigint, 'and sees their clip');
select tests.reset_role();
select tests.set_human(:'viewer'::uuid);
select ok((public.voice_reserve(:'ws'::uuid, 5000, 240044))->>'clip_id' is not null, 'a viewer too: voice is for talking to the agent');
select is((select count(*) from public.voice_clips where user_id = :'owner'::uuid), 0::bigint, 'and sees no one else''s clip');
select tests.reset_role();
select tests.set_human(:'outsider'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT403', 'a stranger does not');
select tests.reset_role();
select tests.set_human(:'owner'::uuid, 'chat-client');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT403', 'a chat session acting as the person does not');
select is((select count(*) from public.voice_clips), 0::bigint, 'nor reads the clips');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), '42501', 'anon does not');
select tests.reset_role();
select tests.set_agent(:'agent_user'::uuid, :'agent'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT403', 'an agent does not reserve as a person');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044, 'telegram', '5')$q$, :'ws')), 'PT403', 'a common agent has no channel');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select ok((public.voice_reserve(:'ws'::uuid, 5000, 240044, 'telegram', '5'))->>'clip_id' is not null, 'the platform agent reserves for its chat');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044, 'whatsapp', '5')$q$, :'ws')), 'PT403', 'whatsapp is not linked yet');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044, 'telegram', 'abc')$q$, :'ws')), 'PT403', 'a chat id that is not one fails closed');
select tests.reset_role();
select is((select user_id from public.voice_clips where channel = 'telegram' limit 1), :'owner'::uuid, 'the clip belongs to the person of the chat');

-- C. Limits, before any cost.
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 100, 4844)$q$, :'ws')), 'PT422', 'too short');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 300001, 14400092)$q$, :'ws')), 'PT413', 'too long');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 14500001)$q$, :'ws')), 'PT413', 'too large');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, null, 44)$q$, :'ws')), 'PT422', 'no duration');
select tests.reset_role();
select is((select count(*) from public.voice_clips), 3::bigint, 'none of those left a clip');
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 600001, 28800092, 'telegram', '5')$q$, :'ws')), 'PT413', 'a channel stops at ten minutes');
select ok((public.voice_reserve(:'ws'::uuid, 600000, 28800044, 'telegram', '5'))->>'clip_id' is not null, 'and ten minutes fit');
select tests.reset_role();
delete from public.voice_clips where duration_ms = 600000;

-- Quota by the hour and by the day.
insert into public.voice_clips (workspace_id, user_id, agent_id, channel, status, duration_ms, bytes, model)
select :'ws'::uuid, :'viewer'::uuid, :'pa'::uuid, 'surface', 'transcribed', 1000, 48044, 'muse-voice-transcribe-1.0' from generate_series(1, 29);
select tests.set_human(:'viewer'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT429', 'thirty clips in an hour');
select tests.reset_role();
delete from public.voice_clips where user_id = :'viewer'::uuid;
insert into public.voice_clips (workspace_id, user_id, agent_id, channel, status, duration_ms, bytes, model, created_at)
values (:'ws'::uuid, :'viewer'::uuid, :'pa'::uuid, 'surface', 'transcribed', 1799000, 48044, 'muse-voice-transcribe-1.0', now() - interval '2 hours');
select tests.set_human(:'viewer'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT429', 'half an hour of audio in a day');
select tests.reset_role();
delete from public.voice_clips where user_id = :'viewer'::uuid;
insert into public.voice_clips (workspace_id, user_id, agent_id, channel, status, duration_ms, bytes, model, created_at)
values (:'ws'::uuid, :'outsider'::uuid, :'pa'::uuid, 'surface', 'transcribed', 17999000, 48044, 'muse-voice-transcribe-1.0', now() - interval '2 hours');
select tests.set_human(:'viewer'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT429', 'and 300 minutes across everyone');
select tests.reset_role();
delete from public.voice_clips where user_id = :'outsider'::uuid;
select is((select count(*) from public.voice_clips where status = 'failed'), 0::bigint, 'no failed clip yet');

-- Budget: spent, plus open reservations, plus this clip.
update public.agents set monthly_budget_usd = 0.012 where id = :'pa'::uuid;
select tests.set_human(:'viewer'::uuid);
select ok((public.voice_reserve(:'ws'::uuid, 180000, 8640044))->>'clip_id' is not null, 'three minutes fit in 0.012, with 0.0 spent');
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 180000, 8640044)$q$, :'ws')), 'PT402', 'a second one does not: the open reservation counts');
select tests.reset_role();
update public.voice_clips set created_at = now() - interval '6 minutes' where user_id = :'viewer'::uuid and status = 'reserved';
select tests.set_human(:'viewer'::uuid);
select ok((public.voice_reserve(:'ws'::uuid, 180000, 8640044))->>'clip_id' is not null, 'a reservation nobody finished expires and frees the budget');
select tests.reset_role();
select is((select error from public.voice_clips where status = 'expired' limit 1), 'no_answer', 'and says why');
update public.agents set monthly_budget_usd = null where id = :'pa'::uuid;

-- D. Nobody states the cost but the function that heard the provider.
select tests.set_human(:'owner'::uuid);
select public.voice_reserve(:'ws'::uuid, 61900, 2971244)->>'clip_id' as clip \gset
select is(tests.sqlstate_of(format($q$select public.voice_complete(%L, 1)$q$, :'clip')), '42501', 'a person cannot complete a clip');
select is(tests.sqlstate_of(format($q$select public.voice_fail(%L, 'x')$q$, :'clip')), '42501', 'nor fail it');
select is(tests.sqlstate_of(format($q$update public.voice_clips set cost_usd = 0 where id = %L$q$, :'clip')), '42501', 'nor write the table');
select is(tests.sqlstate_of(format($q$delete from public.voice_clips where id = %L$q$, :'clip')), '42501', 'nor delete from it');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_complete(%L, 1)$q$, :'clip')), '42501', 'nor the platform agent');
select tests.reset_role();

set local role service_role;
select is((public.voice_complete(:'clip'::uuid, 61900))->>'cost_usd', '0.003050', 'the provider''s minutes, in whole seconds, become cost');
select is((public.voice_complete(:'clip'::uuid, 999999))->>'cost_usd', '0.003050', 'a second completion changes nothing');
reset role;
select is((select r.cost_usd from public.agent_runs r join public.agent_tasks t on t.id = r.task_id where t.request_kind = 'voice' and t.owner_user_id = :'owner'::uuid), 0.003050::numeric, 'the cost reaches a run, which every budget check sums');
select is((select count(*) from public.agent_tasks where request_kind = 'voice' and owner_user_id = :'owner'::uuid), 1::bigint, 'one ledger per person and month');
select is((select delegate_agent_id from public.agent_tasks where request_kind = 'voice' and owner_user_id = :'owner'::uuid), null, 'it is in no agent''s list');
select tests.set_human(:'viewer'::uuid);
select is((select count(*) from public.agent_tasks where request_kind = 'voice' and owner_user_id = :'owner'::uuid), 0::bigint, 'and nobody else sees it');
select tests.reset_role();

select tests.set_human(:'owner'::uuid);
select public.voice_reserve(:'ws'::uuid, 5000, 240044)->>'clip_id' as failed \gset
select tests.reset_role();
set local role service_role;
select is((public.voice_fail(:'failed'::uuid, 'provider_error'))->>'status', 'failed', 'a provider failure ends the reservation');
select is((public.voice_complete(:'failed'::uuid, 5000))->>'status', 'failed', 'and it cannot be charged afterwards');
reset role;

-- E. A deleted page takes the ledger with it, not the record of what was spent.
alter table public.pages disable trigger user;
delete from public.pages where id = (select page_id from public.note_pages where user_id = :'owner'::uuid);
alter table public.pages enable trigger user;
select is((select count(*) from public.voice_clips where id = :'clip'::uuid and ledger_run is null), 1::bigint, 'the clip outlives its ledger');
update public.agents set monthly_budget_usd = 0.003 where id = :'pa'::uuid;
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$select public.voice_reserve(%L, 5000, 240044)$q$, :'ws')), 'PT402', 'and its cost still counts against the budget');
select tests.reset_role();
update public.agents set monthly_budget_usd = null where id = :'pa'::uuid;

-- F. A message names one finished clip of its own person, once.
update public.voice_clips set status = 'failed' where status = 'reserved';
select tests.set_human(:'owner'::uuid);
select public.voice_reserve(:'ws'::uuid, 5000, 240044)->>'clip_id' as c1 \gset
select public.voice_reserve(:'ws'::uuid, 5000, 240044, 'surface', null, false, 'en')->>'clip_id' as c2 \gset
select is(tests.sqlstate_of(format($q$select public.post_agent_message(%L, 'hola', gen_random_uuid(), '{}', %L)$q$, :'ws', :'c1')), 'PT422', 'a clip still running names no message');
select tests.reset_role();
set local role service_role;
select public.voice_complete(:'c1'::uuid, 5000); select public.voice_complete(:'c2'::uuid, 5000);
reset role;
select tests.set_human(:'viewer'::uuid);
select is(tests.sqlstate_of(format($q$select public.post_agent_message(%L, 'hola', gen_random_uuid(), '{}', %L)$q$, :'ws', :'c1')), 'PT422', 'another person''s clip does not bind');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select is((public.post_agent_message(:'ws'::uuid, 'guarda en notas: leche', gen_random_uuid(), '{}', :'c1'::uuid))#>>'{outcome,kind}', 'for_agent', 'a corrected transcript sent by the person is the person''s message');
select is((select kind from public.agent_messages where direction = 'in' order by seq desc limit 1), 'voice', 'it is marked as voice');
select is((select intent->>'kind' from public.agent_messages where direction = 'in' order by seq desc limit 1), 'save', 'and its request counts');
select is(tests.sqlstate_of(format($q$select public.post_agent_message(%L, 'otra', gen_random_uuid(), '{}', %L)$q$, :'ws', :'c1')), 'PT422', 'a clip names one message');
select tests.reset_role();

-- G. A forwarded audio is data, whatever it says, and the clip decides that.
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.voice_reserve(:'ws'::uuid, 5000, 240044, 'telegram', '5', true)->>'clip_id' as fw \gset
select tests.reset_role();
set local role service_role;
select public.voice_complete(:'fw'::uuid, 5000);
reset role;
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is((public.relay_person_message('5', 900, 'guarda en notas: reenviado', 'voice', false, null, :'fw'::uuid))#>>'{outcome,kind}', 'for_agent', 'a forwarded clip stays data even if the relay forgets to say so');
select tests.reset_role();
select is((select forwarded from public.agent_messages where id = (select message_id from public.voice_clips where id = :'fw'::uuid)), true, 'the message is marked forwarded');
select is((select intent from public.agent_messages where id = (select message_id from public.voice_clips where id = :'fw'::uuid)), null, 'and carries no request');

-- H. Voice never decides.
insert into public.agent_tasks (id, workspace_id, context_id, row_page_id, title, delegate_agent_id, owner_user_id, created_by, created_by_type, state)
values ('00000000-0000-4000-8000-00000000b001', :'ws'::uuid, '00000000-0000-4000-8000-00000000b001', 'page_B', 'Ship', :'pa'::uuid, :'owner'::uuid, :'owner'::uuid, 'human', 'input_required');
insert into public.agent_approvals (id, workspace_id, task_id, kind, question, requested_by_type, requested_by_id)
values ('00000000-0000-4000-8000-00000000b002', :'ws'::uuid, '00000000-0000-4000-8000-00000000b001', 'action', 'Ship it?', 'agent', :'pa'::uuid);
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.voice_reserve(:'ws'::uuid, 5000, 240044, 'telegram', '5')->>'clip_id' as ap \gset
select tests.reset_role();
set local role service_role;
select public.voice_complete(:'ap'::uuid, 5000);
reset role;
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is((public.relay_person_message('5', 901, 'apruebo', 'voice', false, null, :'ap'::uuid))#>>'{outcome,kind}', 'for_agent', 'saying "apruebo" is a message for the agent');
select is(tests.sqlstate_of($q$select public.decide_approval('00000000-0000-4000-8000-00000000b002', 'approve')$q$), 'PT403', 'and an agent cannot decide an approval');
select tests.reset_role();
select is((select status from public.agent_approvals where id = '00000000-0000-4000-8000-00000000b002'), 'pending', 'the approval is untouched');

-- I. The same delivery does not pay twice.
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is((public.voice_reserve(:'ws'::uuid, 5000, 240044, 'telegram', '5', false, 'es', 901))->>'duplicate', 'true', 'a voice note already delivered reaches no model');
select ok((public.voice_reserve(:'ws'::uuid, 5000, 240044, 'telegram', '6', false, 'es', 901))->>'clip_id' is not null, 'the key belongs to the chat');
select tests.reset_role();

select * from finish();
rollback;
