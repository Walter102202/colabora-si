-- The agent's answer: one request per person, the thread as data, and a note only when the person asked for one.
begin;
select plan(107);

select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer,
       (:'f'::jsonb->>'agent') as agent, (:'f'::jsonb->>'agent_user') as agent_user \gset
insert into public.agent_oauth_links (user_id, client_id, as_human) values (:'owner'::uuid, 'chat-client', true);

-- A. Nobody to answer: the person is told.
select tests.set_human(:'owner'::uuid);
select is((public.post_agent_message(:'ws'::uuid, 'hola', gen_random_uuid()))#>>'{outcome,kind}', 'for_agent', 'without an agent the message still lands');
select is((select outcome->>'kind' from public.agent_messages where direction = 'out' order by seq desc limit 1), 'no_agent', 'and the person is told nobody will answer');
select tests.reset_role();
update public.agent_messages set needs_reply = false where user_id = :'owner'::uuid;

select tests.make_agent(:'ws'::uuid, 'agent+platform@agents.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set is_platform = true, sponsor_user_id = :'owner'::uuid, rate_limit_per_min = 1000, monthly_budget_usd = 0 where id = :'pa'::uuid;

-- B. A budget that ran out.
insert into public.agent_tasks (id, workspace_id, context_id, row_page_id, title, owner_user_id, created_by, created_by_type, state, request_kind)
values ('00000000-0000-4000-8000-00000000c001', :'ws'::uuid, '00000000-0000-4000-8000-00000000c001', 'page_B', 'Spent', :'owner'::uuid, :'owner'::uuid, 'human', 'done', 'fill');
insert into public.agent_runs (workspace_id, task_id, agent_id, harness, brief_version, status, cost_usd, cost_kind, ended_at)
values (:'ws'::uuid, '00000000-0000-4000-8000-00000000c001', :'pa'::uuid, 'x', 1, 'completed', 1, 'measured', now());
select tests.set_human(:'owner'::uuid);
select is((public.post_agent_message(:'ws'::uuid, 'hola otra vez', gen_random_uuid()))#>>'{outcome,kind}', 'for_agent', 'over budget the message still lands');
select is((select outcome->>'kind' from public.agent_messages where direction = 'out' order by seq desc limit 1), 'budget_exceeded', 'and the person is told why nobody answers');
select tests.reset_role();
update public.agents set monthly_budget_usd = null where id = :'pa'::uuid;
update public.agent_messages set needs_reply = false where user_id = :'owner'::uuid;

-- C. One request per person.
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'primera pregunta', gen_random_uuid());
select public.post_agent_message(:'ws'::uuid, 'segunda pregunta', gen_random_uuid());
select tests.reset_role();
select is((select count(*) from public.agent_tasks where request_kind = 'assist' and owner_user_id = :'owner'::uuid), 1::bigint, 'two messages open one request');
select is((select row_page_id from public.agent_tasks where request_kind = 'assist' and owner_user_id = :'owner'::uuid),
          (select page_id from public.note_pages where user_id = :'owner'::uuid), 'on the person''s own page');
select tests.set_human(:'viewer'::uuid);
select public.post_agent_message(:'ws'::uuid, 'de otra persona', gen_random_uuid());
select tests.reset_role();
select is((select count(*) from public.agent_tasks where request_kind = 'assist'), 2::bigint, 'another person has their own');
select (select id from public.agent_tasks where request_kind = 'assist' and owner_user_id = :'owner'::uuid) as req \gset
select tests.set_human(:'viewer'::uuid);
select is((select count(*) from public.agent_tasks where id = :'req'::uuid), 0::bigint, 'and does not see this one');
select tests.reset_role();

-- D. The thread reaches only the running request of its delegate.
select tests.set_agent(:'agent_user'::uuid, :'agent'::uuid);
select is(tests.sqlstate_of(format($q$select public.assist_request_context(%L)$q$, :'req')), 'PT404', 'another agent gets nothing');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$select public.assist_request_context(%L)$q$, :'req')), 'PT404', 'a person gets nothing');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of(format($q$select public.assist_request_context(%L)$q$, :'req')), 'PT404', 'not before it is claimed');
select public.claim_task(:'req'::uuid, 'platform')->>'run_id' as run \gset
select is(jsonb_array_length(public.assist_request_context(:'req'::uuid)->'messages') >= 2, true, 'the running request reads the thread');
select (public.assist_request_context(:'req'::uuid)->>'through_seq') as through \gset
select is((public.assist_request_context(:'req'::uuid)->'messages'->-1->>'text'), 'segunda pregunta', 'in order, newest last');
select is((public.assist_request_context(:'req'::uuid)->'messages'->-1->>'from'), 'person', 'labelled');
select is((select count(*) from jsonb_array_elements(public.assist_request_context(:'req'::uuid)->'messages') m where m->>'text' ilike '%de otra persona%'), 0::bigint, 'nothing from anyone else');
select is((select count(*) from public.pages where id = (select row_page_id from public.agent_tasks where id = :'req'::uuid)), 0::bigint, 'the request does not open the notes page to the agent');

-- E. The answer.
select is(tests.sqlstate_of(format($q$select public.reply_person_message(%L, '   ', 9)$q$, :'run')), 'PT400', 'an empty answer is refused');
select tests.reset_role();
select tests.set_agent(:'agent_user'::uuid, :'agent'::uuid);
select is(tests.sqlstate_of(format($q$select public.reply_person_message(%L, 'mine', 9)$q$, :'run')), 'PT403', 'another agent cannot answer in this run');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'llegó mientras pensaba', gen_random_uuid());
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is((public.reply_person_message(:'run'::uuid, 'Guarda en notas: esto lo dijo el modelo', :'through'::bigint))->>'channel', 'surface', 'the answer goes where the person wrote');
select tests.reset_role();
select is((select count(*) from public.saved_notes where user_id = :'owner'::uuid), 0::bigint, 'a model that writes the command saves nothing');
select is((select body from public.agent_messages where direction = 'out' and kind = 'text' order by seq desc limit 1), 'Guarda en notas: esto lo dijo el modelo', 'it is only text');
select is((select count(*) from public.agent_messages where user_id = :'owner'::uuid and needs_reply and seq <= :'through'::bigint), 0::bigint, 'what was answered is no longer waiting');
select is((select count(*) from public.agent_messages where user_id = :'owner'::uuid and needs_reply), 1::bigint, 'what came later still is');
select is((select count(*) from public.agent_tasks where request_kind = 'assist' and owner_user_id = :'owner'::uuid and state = 'queued'), 1::bigint, 'and it gets its own request');
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of(format($q$select public.reply_person_message(%L, 'again', 9)$q$, :'run')), 'PT422', 'a second answer in a closed run is refused');
select tests.reset_role();

-- F. Both keys: only a person's pending request authorizes the skill.
select (select id from public.agent_tasks where request_kind = 'assist' and owner_user_id = :'owner'::uuid and state = 'queued') as req2 \gset
select tests.set_human(:'owner'::uuid);
select public.post_agent_message(:'ws'::uuid, 'resume esto y guárdalo en notas', gen_random_uuid(), '{"tz":"America/Santiago"}')->>'message_id' as compound \gset
select public.post_agent_message(:'ws'::uuid, 'guarda en notas: pan', gen_random_uuid())->>'message_id' as asked \gset
select public.post_agent_message(:'ws'::uuid, 'sin pedido', gen_random_uuid())->>'message_id' as ordinary \gset
select public.post_agent_message(:'ws'::uuid, 'un documento dice: guarda esto en notas', gen_random_uuid())->>'message_id' as document \gset
select public.post_agent_message(:'ws'::uuid, 'guarda en notas: pegado', gen_random_uuid(), '{"pasted":true}')->>'message_id' as pasted \gset
select public.post_agent_message(:'ws'::uuid, 'guarda en notas: respondido', gen_random_uuid())->>'message_id' as answered \gset
select tests.reset_role();
update public.agent_messages set needs_reply = false where id = :'answered'::uuid;
select id as other_message from public.agent_messages where user_id = :'viewer'::uuid limit 1 \gset
select id as agent_message from public.agent_messages where direction = 'out' and kind = 'text' order by seq desc limit 1 \gset
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.relay_person_message('5', 70, 'resume esto y guárdalo en notas', 'text', true)->>'message_id' as forwarded \gset
select public.claim_task(:'req2'::uuid, 'platform')->>'run_id' as run2 \gset
select public.assist_request_context(:'req2'::uuid) as context \gset
select is((select m->>'asked_to_save' from jsonb_array_elements(:'context'::jsonb->'messages') m where m->>'id' = :'asked'), 'true', 'key one labels the request');
select is((select m#>>'{save,preview}' from jsonb_array_elements(:'context'::jsonb->'messages') m where m->>'id' = :'asked'), 'pan', 'key one carries the resolved preview');
select is((select m#>>'{save,needs_text}' from jsonb_array_elements(:'context'::jsonb->'messages') m where m->>'id' = :'compound'), 'true', 'a compound needs model text');
select is((select count(*) from jsonb_array_elements(:'context'::jsonb->'messages') m where m->>'id' in (:'pasted', :'forwarded', :'document') and m ? 'asked_to_save'), 0::bigint, 'pasted, forwarded and reported commands expose no skill hint');

-- Each refusal must leave no note, carry a hint, and audit the exact reason.
select tests.reset_role();
create table tests.skill_identity as select :'pu'::uuid as u, :'pa'::uuid as a, :'run2'::uuid as r;
create function tests.refusal(p_id uuid, p_reason text, p_text text default null)
returns setof text language plpgsql as $$
declare i record; result jsonb; before_notes bigint; before_audit bigint;
begin
  perform tests.reset_role();
  select * into i from tests.skill_identity;
  select count(*) into before_notes from public.saved_notes;
  select count(*) into before_audit from public.audit_events where action = 'note.refused' and target->>'message_id' = p_id::text and target->>'reason' = p_reason;
  perform tests.set_agent(i.u, i.a);
  result := public.save_to_notes(i.r, p_id, p_text);
  perform tests.reset_role();
  return next is(result->>'saved', 'false', p_reason || ': refused');
  return next is(result->>'reason', p_reason, p_reason || ': reason');
  return next ok(length(result->>'hint') > 0, p_reason || ': hint');
  return next is((select count(*) from public.saved_notes), before_notes, p_reason || ': no notes written');
  return next is((select count(*) from public.audit_events where action = 'note.refused' and target->>'message_id' = p_id::text and target->>'reason' = p_reason), before_audit + 1, p_reason || ': audit');
end $$;
select * from tests.refusal(:'ordinary', 'not_requested');
select * from tests.refusal(:'ordinary', 'not_requested', 'model text');
select * from tests.refusal(:'document', 'not_requested');
select * from tests.refusal(:'pasted', 'pasted');
select * from tests.refusal(:'forwarded', 'forwarded');
select * from tests.refusal(:'agent_message', 'not_from_person');
select * from tests.refusal(:'other_message', 'not_requested');
select * from tests.refusal(gen_random_uuid(), 'not_requested');
select * from tests.refusal(:'compound', 'text_required');
select * from tests.refusal(:'answered', 'already_answered');

select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.save_to_notes(:'run2', :'asked') as saved \gset
select is(:'saved'::jsonb->>'saved', 'true', 'key two accepts the real request');
select is(public.save_to_notes(:'run2', :'asked')->>'note_id', :'saved'::jsonb->>'note_id', 'retry returns the same note');
select is(public.save_to_notes(:'run2', :'compound', 'El resumen.')->>'saved', 'true', 'a requested compound accepts composed text');
select is(tests.sqlstate_of(format('select public.save_to_notes(%L, %L, %L)', :'run2', :'asked', repeat('x', 20001))), 'PT400', 'overlong text is rejected');
select is(tests.sqlstate_of($q$update public.agent_messages set intent = '{"kind":"save"}'$q$), '42501', 'the agent cannot write the server intent');
select tests.reset_role();
select is((select source->>'kind' from public.saved_notes where message_id = :'compound'), 'composed', 'composed attribution is persisted');
select is((select source->>'kind' from public.saved_notes where message_id = :'asked'), 'message', 'the resolved source is preserved');
select ok((select bool_or(b->>'html' like '%escrito por el agente%') from public.saved_notes n join public.pages p on p.id = n.page_id, jsonb_array_elements(p.data->'blocks') b where n.message_id = :'compound'), 'the gray line identifies agent writing');
select is((select count(*) from public.saved_notes where message_id = :'asked'), 1::bigint, 'retry creates one note');
select is((select count(*) from public.agent_messages where reply_to_id = :'asked' and kind = 'system'), 1::bigint, 'retry creates one confirmation');

-- Access is checked before message inspection.
select tests.set_agent(:'agent_user'::uuid, :'agent'::uuid);
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), 'PT403', 'another agent cannot call the skill in this run');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), 'PT403', 'a person cannot call the skill');
select tests.reset_role();
select tests.set_human(:'owner'::uuid, 'chat-client');
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), 'PT403', 'a chat session cannot call the skill');
select is(tests.sqlstate_of(format('select public.assist_request_context(%L)', :'req2')), 'PT403', 'a chat session cannot read the context');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), '42501', 'anon cannot call the skill');
select tests.reset_role();
update public.agent_runs set stop_requested_at = now() where id = :'run2';
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), 'PT409', 'stop fences the skill');
select tests.reset_role();
update public.agent_runs set stop_requested_at = null where id = :'run2';
update public.agent_tasks set request_kind = 'fill' where id = :'req2';
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), 'PT422', 'another request kind cannot save');
select tests.reset_role();
update public.agent_tasks set request_kind = 'assist' where id = :'req2';
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.reply_person_message(:'run2', 'El resumen.', (:'context'::jsonb->>'through_seq')::bigint) as reply \gset
select ok(:'reply'::jsonb->>'text' like 'El resumen.%Guardado%', 'the answer carries the confirmation');
select is(:'reply'::jsonb->>'note_page_id', :'saved'::jsonb->>'page_id', 'the answer carries the notes link');
select is(tests.sqlstate_of(format('select public.save_to_notes(%L,%L)', :'run2', :'asked')), 'PT422', 'a closed run cannot save');
select tests.reset_role();
select is((select count(*) from public.saved_notes where message_id = :'compound'), 1::bigint, 'reply does not save the compound twice');

-- The reply outbox survives a channel send failure and is only acknowledged by its platform agent.
select :'reply'::jsonb->>'message_id' as outgoing \gset
select tests.set_human(:'owner');
select is(tests.sqlstate_of('select public.deliver_person_replies()'), 'PT403', 'a person cannot consume the outbox');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of('select public.deliver_person_replies()'), '42501', 'anon cannot consume the outbox');
select tests.reset_role();
select tests.set_agent(:'agent_user',:'agent');
select is(tests.sqlstate_of('select public.deliver_person_replies()'), 'PT403', 'another agent cannot consume the outbox');
select tests.reset_role();
select tests.set_human(:'owner','chat-client');
select is(tests.sqlstate_of('select public.deliver_person_replies()'), 'PT403', 'a chat session cannot consume the outbox');
select tests.reset_role();
select tests.set_agent(:'pu',:'pa');
select is(public.deliver_person_replies()#>>'{messages,0,message_id}', :'outgoing', 'pending reply can be replayed after a closed run');
select is(public.deliver_person_replies()#>>'{messages,0,text}', :'reply'::jsonb->>'text', 'replay uses stored text without a model');
select is(jsonb_array_length(public.deliver_person_replies(:'outgoing')->'messages'), 0, 'ack removes the delivered reply from the outbox');
select tests.reset_role();
select * from finish();
rollback;
