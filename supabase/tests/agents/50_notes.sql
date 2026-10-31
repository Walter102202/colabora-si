-- Two keys: the agent calls the skill; the server checks the person request and its resolved source.
begin;
select plan(201);

select tests.fixture() as f \gset
select (:'f'::jsonb->>'ws') as ws, (:'f'::jsonb->>'owner') as owner, (:'f'::jsonb->>'viewer') as viewer \gset
select tests.make_agent(:'ws'::uuid, 'agent+platform@agents.invalid', 'lead', 'page_B') as pl \gset
select (:'pl'::jsonb->>'agent') as pa, (:'pl'::jsonb->>'user') as pu \gset
update public.agents set rate_limit_per_min = 1000, is_platform = true, sponsor_user_id = :'owner'::uuid where id = :'pa'::uuid;
create table tests.notes_agent as select :'pu'::uuid as agent_user, :'pa'::uuid as agent;
insert into public.agent_oauth_links (user_id, client_id, as_human) values (:'owner'::uuid, 'chat-client', true);

-- A. The words. A positive names the mode it must find; a negative must find nothing.
select is(private.note_command(t)->>'mode', m, 'asks: ' || t) from (values
  ('Perfecto, gracias. Guarda esto en notas.', 'reference'), ('El código es 1234. Guárdalo en notas', 'reference'), (E'Lista del súper\nguarda esto en notas', 'reference'), ('Thanks! Save this in notes.', 'reference'),
  ('guarda esto en notas', 'reference'), ('Guarda esto en notas.', 'reference'), ('guárdalo en notas', 'reference'), ('guardalo en notas', 'reference'),
  ('guárdame esto en mis notas', 'reference'), ('guardar esto en notas', 'reference'), ('guarda esto en nota', 'reference'), ('guarda esto a notas', 'reference'),
  ('guarda, esto en notas', 'reference'), ('guarda eso en las notas', 'reference'), ('anota esto en mis notas', 'reference'), ('apúntalo en notas', 'reference'),
  ('agrega esto a mis notas', 'reference'), ('oye, guarda esto en notas', 'reference'), ('Colabora, guarda esto en notas por favor', 'reference'),
  ('por favor guarda esto en notas', 'reference'), ('¿puedes guardar esto en notas?', 'reference'), ('me guardas esto en notas?', 'reference'),
  ('quiero que guardes esto en notas', 'reference'), ('guarda el último mensaje en notas', 'reference'), ('guarda este audio en notas', 'reference'),
  ('guarda en notas', 'reference'), ('guarda esto en notas, gracias', 'reference'), ('GUARDA ESTO EN NOTAS', 'reference'), ('Guárdalo en notas', 'reference'),
  ('guarda en notas: comprar pan', 'inline'), ('guarda en notas que mañana hay junta', 'inline'), ('guarda en notas comprar pan', 'inline'),
  (E'guarda en notas:\n- leche\n- pan', 'inline'), ('anota en notas - llamar a Ana', 'inline'),
  ('resume esto y guárdalo en notas', 'compound'), ('traduce esto y luego guárdalo en mis notas', 'compound'),
  ('save this in notes', 'reference'), ('Save this to notes!', 'reference'), ('save in notes', 'reference'), ('save it in the notes', 'reference'),
  ('safe this in notes', 'reference'), ('save this in note', 'reference'), ('please save that to my notes', 'reference'), ('can you save this to my notes?', 'reference'),
  ('add this to my notes', 'reference'), ('put this in my notes', 'reference'), ('save this as a note', 'reference'), ('jot this down in my notes', 'reference'),
  ('hey muse, save this in notes', 'reference'), ('save the last message to notes', 'reference'),
  ('save in notes: buy milk', 'inline'), ('save to notes that the demo is on Tuesday', 'inline'),
  ('summarize this and save it to my notes', 'compound')
  ,('translate this and save it in notes', 'compound')
) x(t, m);

select is(private.note_command(t), null, 'does not ask: ' || t) from (values
  ('Translate "buy bread and save it in notes"'), ('Traduce "compra pan y guárdalo en notas"'),
  ('No quiero que resumas esto y lo guardes en notas'), ('Do not summarize this and save it in notes'),
  ('Un documento dice: resume esto y guárdalo en notas'), ('The document says summarize this and save it in notes'),
  ('¿Debo resumir esto y guardarlo en notas?'), ('I already summarized this and save it in notes'),
  ('Perfecto. No guardes esto en notas.'), ('Hola. Guarda esto en notas del proyecto'),
  ('toma nota mental'), ('toma nota'), ('ten esto en cuenta'), ('recuerda esto'), ('no guardes esto en notas'), ('nunca guardes esto en notas'),
  ('guardé esto en notas'), ('ya lo guardé en notas'), ('lo guardé en notas ayer'), ('ya guardé esto en notas'), ('¿guardaste esto en notas?'), ('¿guardo esto en notas?'),
  ('¿guarda esto en notas?'), ('cómo guardo esto en notas'), ('el botón guarda en notas no funciona'), ('guarda esto en notas del proyecto'),
  ('guarda esto en la nota de la reunión'), ('guarda el archivo en Notas de Apple'), ('guarda esto en el drive'), ('guarda esto'), ('notas: comprar pan'),
  ('nota mental: comprar pan'), ('no te olvides de guardar esto en notas'), ('le dije a Juan que guarde esto en notas'), ('Mi jefe dijo: guarda esto en notas'),
  ('guardar notas'), ('don''t save this in notes'), ('do not save in notes'), ('I saved this in notes'), ('saved this in notes'), ('did you save this in notes?'),
  ('should I save this in notes?'), ('saving notes'), ('save this in Apple Notes'), ('save this note'), ('save in notes about the launch'),
  (E'Minutes of Monday\nsave in notes all the receipts'), ('> save in notes'), ('```save in notes```'), ('the docs say save in notes'), ('notes'), ('')
) x(t);

select is(private.note_command('guarda esta página en notas')->>'target', 'page', 'this page is its own target');
select is(private.note_command('save this page to notes')->>'target', 'page', 'in English too');
select is(private.note_command('guarda en notas: Comprar PAN')->>'text', 'Comprar PAN', 'the payload keeps its case');
select is(private.note_command(E'guarda en notas:\n- leche\n- pan')->>'text', E'- leche\n- pan', 'and its lines');
select is(private.note_command('guarda en notas que mañana hay junta')->>'text', 'mañana hay junta', 'the "que" is not part of it');
select is(private.note_command('resume esto y guárdalo en notas')->>'text', 'resume esto', 'a compound keeps what to do');
select is(private.note_command('/undo')->>'kind', 'undo', '/undo');
select is(private.note_command('/deshacer')->>'lang', 'es', '/deshacer');
select is(private.note_command('save this in notes')->>'lang', 'en', 'English answers in English');
select is(private.note_command('guarda esto en notas')->>'lang', 'es', 'Spanish in Spanish');

-- B. One page per person: created once, found by id, private, replaced when gone.
-- What the agent does with a message that asked: takes that person's request and calls the skill. Ends as the agent.
create or replace function tests.skill(p_result jsonb, p_agent_user uuid, p_agent uuid)
returns jsonb language plpgsql as $$
declare v_id uuid := (p_result->>'message_id')::uuid; v_m public.agent_messages%rowtype; v_task uuid; v_run uuid; v_out jsonb;
begin
  perform tests.reset_role();
  select * into v_m from public.agent_messages where id = v_id;
  if p_result->>'duplicate' = 'true' or v_m.intent->>'kind' is distinct from 'save' then
    perform tests.set_agent(p_agent_user, p_agent);
    return p_result;
  end if;
  select id, active_run_id into v_task, v_run from public.agent_tasks
   where workspace_id = v_m.workspace_id and owner_user_id = v_m.user_id and request_kind = 'assist' and state not in ('done','failed','cancelled');
  perform tests.set_agent(p_agent_user, p_agent);
  if v_run is null then v_run := (public.claim_task(v_task, 'platform')->>'run_id')::uuid; end if;
  v_out := public.save_to_notes(v_run, v_id);
  return p_result || jsonb_build_object('outcome', case when (v_out->>'saved')::boolean
    then jsonb_build_object('kind', 'note_saved', 'note_id', v_out->>'note_id', 'page_id', v_out->>'page_id')
    else jsonb_build_object('kind', 'not_saved', 'reason', v_out->>'reason', 'hint', v_out->>'hint') end);
end $$;

create or replace function tests.say(p_user uuid, p_ws uuid, p_body text, p_key text, p_ctx jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare v jsonb; a record;
begin
  select * into a from tests.notes_agent;
  perform tests.set_human(p_user);
  v := public.post_agent_message(p_ws, p_body, ('00000000-0000-4000-8000-' || lpad(p_key, 12, '0'))::uuid, p_ctx);
  v := tests.skill(v, a.agent_user, a.agent);
  perform tests.reset_role();
  return v;
end $$;
select tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda en notas: comprar pan', '1', '{"tz":"America/Santiago"}') as r1 \gset
select is(:'r1'::jsonb#>>'{outcome,kind}', 'note_saved', 'an inline note is saved');
select (:'r1'::jsonb#>>'{outcome,page_id}') as np, (:'r1'::jsonb#>>'{outcome,note_id}') as n1 \gset
select is((select data->>'title' from public.pages where id = :'np'), 'Notas', 'the page is titled in the language of the request');
select is((select owner_user_id from public.private_pages where page_id = :'np'), :'owner'::uuid, 'and it is private');
select ok((select root_order ? :'np' from public.workspaces where id = :'ws'::uuid), 'it shows in the owner''s tree');
select ok((select bool_or(b->>'html' = 'comprar pan') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'the text is on the page');
select is((select b->>'type' from public.pages p, jsonb_array_elements(p.data->'blocks') with ordinality e(b, o) where p.id = :'np' and o = 2), 'heading3', 'under a heading with the day');
select ok((select bool_or(b->>'html' ~ '^[0-9]{2}:[0-9]{2} · Chat$') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'with the hour and the source');
select is((select count(*) from public.agent_messages where direction = 'out' and body = 'Guardado en tus notas.'), 1::bigint, 'the person is told, in their language');
select is((select needs_reply from public.agent_messages where id = (:'r1'::jsonb->>'message_id')::uuid), true, 'and it still waits for the agent''s answer');

select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda en notas: comprar pan', '1'))->>'duplicate', 'true', 'a repeat is recognized');
select is((select count(*) from public.saved_notes), 1::bigint, 'a message delivered twice saves once');
select is((select count(*) from public.agent_messages where direction = 'in'), 1::bigint, 'and is stored once');

select tests.reset_role();
alter table public.pages disable trigger pages_30_actor;
select tests.set_human(:'owner'::uuid);
select set_config('app.ops_write', '1', true);
update public.pages set parent_id = 'page_A', data = jsonb_set(data, '{parentId}', '"page_A"') where id = :'np';
select set_config('app.ops_write', '', true);
select tests.reset_role();
alter table public.pages enable trigger pages_30_actor;
select tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda en notas: otra', '2') as r2 \gset
select is(:'r2'::jsonb#>>'{outcome,page_id}', :'np', 'a moved page is found by id');
select is((select count(*) from public.note_pages), 1::bigint, 'there is still one page');
select is((select b->>'html' from public.pages p, jsonb_array_elements(p.data->'blocks') with ordinality e(b, o) where p.id = :'np' and o = 3), 'otra', 'the newest note comes first');

-- The owner's notes are nobody else's: the same page is hidden from another member.
select tests.set_human(:'viewer'::uuid);
select is((select count(*) from public.pages where id = :'np'), 0::bigint, 'another member does not read the notes');
select is((select count(*) from public.agent_messages), 0::bigint, 'nor the conversation');
select is((select count(*) from public.saved_notes), 0::bigint, 'nor the list of notes');
select is(tests.sqlstate_of(format('select public.undo_note(%L)', :'n1')), 'PT404', 'nor undoes one');
select tests.reset_role();
select tests.set_human(:'owner'::uuid, 'chat-client');
select is((select count(*) from public.agent_messages), 0::bigint, 'a chat session acting as the owner reads no conversation');
select tests.reset_role();
select is((select count(*) from public.agent_grants where agent_id = :'pa'::uuid and page_id = :'np'), 0::bigint, 'the agent gets no grant on the page');

-- Another person gets their own page.
select tests.say(:'viewer'::uuid, :'ws'::uuid, 'save in notes: mine', '3') as r3 \gset
select isnt(:'r3'::jsonb#>>'{outcome,page_id}', :'np', 'each person has a page');
select is((select data->>'title' from public.pages where id = :'r3'::jsonb#>>'{outcome,page_id}'), 'Notes', 'titled in their language');

-- C. What "this" means.
select tests.say(:'owner'::uuid, :'ws'::uuid, 'La reunión es el martes', '10') as r10 \gset
select is(:'r10'::jsonb#>>'{outcome,kind}', 'for_agent', 'an ordinary message goes to the agent');
select is((select needs_reply from public.agent_messages where id = (:'r10'::jsonb->>'message_id')::uuid), true, 'and waits for its reply');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda esto en notas', '11'))#>>'{outcome,kind}', 'note_saved', 'a reference takes the last message');
select ok((select bool_or(b->>'html' = 'La reunión es el martes') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'that message is the note');

insert into public.agent_messages (workspace_id, user_id, agent_id, direction, channel, kind, body)
values (:'ws'::uuid, :'owner'::uuid, :'pa'::uuid, 'out', 'surface', 'text', 'Resumen: tres puntos');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda eso en notas', '12'))#>>'{outcome,kind}', 'note_saved', 'the last message can be the agent''s');
select ok((select bool_or(b->>'html' ~ 'respuesta del agente') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'and the note says so');

select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda en notas', '13', '{"quote_text":"citado"}'))#>>'{outcome,kind}', 'note_saved', 'a quote wins over the last message');
select ok((select bool_or(b->>'html' = 'citado') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'the quote is the note');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda esto en notas', '14', jsonb_build_object('selection', jsonb_build_object('page_id', 'page_A', 'text', 'seleccionado'))))#>>'{outcome,kind}',
          'note_saved', 'a selection on a readable page is the target');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda esto en notas', '15', jsonb_build_object('quote_text', 'q', 'selection', jsonb_build_object('page_id', 'page_A', 'text', 's'))))#>>'{outcome,reason}',
          'ambiguous', 'a quote and a selection together are ambiguous');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda esta página en notas', '16', '{"page_id":"page_B"}'))#>>'{outcome,kind}', 'note_saved', 'this page saves a link');
select ok((select bool_or(b->>'html' ~ 'data-page="page_B"') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'the note links to it');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'save this page to notes', '17'))#>>'{outcome,reason}', 'no_target', 'without an open page there is nothing to link');
select is((tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda esto en notas', '18', '{"selection":{"page_id":"nope","text":"x"}}'))#>>'{outcome,reason}', 'no_target', 'a selection on an unknown page is refused');

update public.agent_messages set created_at = now() - interval '2 hours' where workspace_id = :'ws'::uuid and user_id = :'owner'::uuid;
select tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda esto en notas', '19') as r19 \gset
select is(:'r19'::jsonb#>>'{outcome,reason}', 'no_target', 'an old conversation is not "this"');
select ok(:'r19'::jsonb#>>'{outcome,hint}' like 'No sé qué guardar%', 'and the person is told how to say it');

-- D. A message that is not the person's own words never acts.
select tests.set_human(:'owner'::uuid);
select is((public.post_agent_message(:'ws'::uuid, 'save in notes: pasted', '00000000-0000-4000-8000-000000000020'::uuid, '{"pasted":true}'))#>>'{outcome,kind}', 'for_agent', 'pasted text is data');
select tests.reset_role();
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is((public.relay_person_message('5', 21, 'guarda en notas: reenviado', 'voice', true))#>>'{outcome,kind}', 'for_agent', 'a forwarded audio is data');
select is((public.relay_person_message('5', 22, 'approve this', 'voice', true))#>>'{outcome,kind}', 'for_agent', 'it decides nothing');
select is((tests.skill(public.relay_person_message('5', 23, 'guarda esto en notas'), :'pu'::uuid, :'pa'::uuid))#>>'{outcome,kind}', 'note_saved', 'the person can then ask for it, in their own words');
select tests.reset_role();
select ok((select bool_or(b->>'html' ~ 'reenviado$') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'and the note says it was forwarded');

-- E. A channel: only the platform agent, for its sponsor, once per delivery.
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select public.relay_person_message('5', 126, 'mi idea de voz', 'voice');
select public.relay_person_message('5', 127, 'otra cosa');
select is((tests.skill(public.relay_person_message('5', 128, 'guarda esto en notas', 'text', false, null, null, null, 'telegram', 126), :'pu'::uuid, :'pa'::uuid))#>>'{outcome,kind}', 'note_saved', 'a reply to a voice note saves that note');
select tests.reset_role();
select is((select source->>'kind' from public.saved_notes where message_id = (select id from public.agent_messages where external_id = '5:128')), 'quote', 'it saves what was replied to, not the last message');
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is((tests.skill(public.relay_person_message('5', 129, 'guarda esto en notas', 'text', false, null, null, null, 'telegram', 999), :'pu'::uuid, :'pa'::uuid))#>>'{outcome,reason}', 'no_target', 'a reply to something unknown does not fall back to the last message');
select is((tests.skill(public.relay_person_message('5', 30, 'guarda en notas: una vez'), :'pu'::uuid, :'pa'::uuid))#>>'{outcome,kind}', 'note_saved', 'a channel saves a note');
select is((tests.skill(public.relay_person_message('5', 30, 'guarda en notas: una vez'), :'pu'::uuid, :'pa'::uuid))->>'duplicate', 'true', 'the same delivery does not');
select is((tests.skill(public.relay_person_message('6', 30, 'guarda en notas: otro chat'), :'pu'::uuid, :'pa'::uuid))#>>'{outcome,kind}', 'note_saved', 'the key belongs to the chat');
select is((public.relay_person_message('5', 31, '/undo'))#>>'{outcome,kind}', 'note_undone', '/undo takes back the last note');
select is((public.relay_person_message('5', 32, '/undo'))#>>'{outcome,kind}', 'note_undone', 'and again');
select is(tests.sqlstate_of($q$select public.relay_person_message('abc', 33, 'hi')$q$), 'PT403', 'a chat that is not a chat id is refused');
select is(tests.sqlstate_of($q$select public.relay_person_message('5', -1, 'hi')$q$), 'PT400', 'a bad message id too');
select is(tests.sqlstate_of($q$select public.relay_person_message('5', 34, 'hi', 'system')$q$), 'PT400', 'a channel cannot write a system message');
select tests.reset_role();
select tests.set_agent((:'f'::jsonb->>'agent_user')::uuid, (:'f'::jsonb->>'agent')::uuid);
select is(tests.sqlstate_of($q$select public.relay_person_message('5', 40, 'guarda en notas: x')$q$), 'PT403', 'another agent cannot relay');
select is(tests.sqlstate_of(format('select public.post_agent_message(%L, %L, %L)', :'ws', 'guarda en notas: x', '00000000-0000-4000-8000-000000000041')), 'PT403', 'an agent cannot speak as a person');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of($q$select public.relay_person_message('5', 42, 'guarda en notas: x')$q$), 'PT403', 'a person does not relay');
select tests.reset_role();
select tests.set_human(:'owner'::uuid, 'chat-client');
select is(tests.sqlstate_of(format('select public.post_agent_message(%L, %L, %L)', :'ws', 'guarda en notas: x', '00000000-0000-4000-8000-000000000043')), 'PT403', 'a chat session cannot ask as the person');
select is(tests.sqlstate_of(format('select public.undo_note(%L)', :'n1')), 'PT403', 'nor undo');
select is(tests.sqlstate_of(format('select public.my_notes_page(%L)', :'ws')), 'PT403', 'nor open the page');
select tests.reset_role();
select tests.set_anon();
select is(tests.sqlstate_of(format('select public.post_agent_message(%L, %L, %L)', :'ws', 'x', '00000000-0000-4000-8000-000000000044')), '42501', 'anon cannot call it');
select tests.reset_role();
select tests.make_user('stranger@test.local') as stranger \gset
select tests.set_human(:'stranger'::uuid);
select is(tests.sqlstate_of(format('select public.post_agent_message(%L, %L, %L)', :'ws', 'x', '00000000-0000-4000-8000-000000000045')), 'PT403', 'a stranger cannot write');
select tests.reset_role();

-- A former sponsor fails closed.
update public.agents set sponsor_user_id = :'viewer'::uuid where id = :'pa'::uuid;
delete from public.workspace_members where workspace_id = :'ws'::uuid and user_id = :'viewer'::uuid;
select tests.set_agent(:'pu'::uuid, :'pa'::uuid);
select is(tests.sqlstate_of($q$select public.relay_person_message('5', 50, 'hi')$q$), 'PT403', 'a channel of someone who left is dead');
select tests.reset_role();
update public.agents set sponsor_user_id = :'owner'::uuid where id = :'pa'::uuid;
insert into public.workspace_members (workspace_id, user_id, role) values (:'ws'::uuid, :'viewer'::uuid, 'viewer');

-- F. Trash, lock, undo, visibility.
select tests.set_human(:'owner'::uuid);
select is((public.undo_note(:'n1'::uuid))->>'undone', 'true', 'a person undoes a note');
select is((public.undo_note(:'n1'::uuid))->>'undone', 'true', 'twice is harmless');
select is((select count(*) from public.agent_messages where outcome->>'note_id' = :'n1' and outcome->>'kind' = 'note_saved'), 0::bigint, 'undo updates the confirmation consumed by Realtime');
select tests.reset_role();
select ok(not (select bool_or(b->>'html' = 'comprar pan') from public.pages p, jsonb_array_elements(p.data->'blocks') b where p.id = :'np'), 'its text is gone');
select is((select data->'blocks' @> jsonb_build_array(jsonb_build_object('key', 'notes:about')) from public.pages where id = :'np'), true, 'the page stays');

select tests.reset_role();
select set_config('app.ops_write', '1', true);
alter table public.pages disable trigger pages_30_actor;
update public.pages set data = jsonb_set(data, '{locked}', 'true') where id = :'np';
select tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda en notas: bloqueada', '60') as r60 \gset
select is(:'r60'::jsonb#>>'{outcome,reason}', 'page_locked', 'a locked page saves nothing and says why');
select is((select count(*) from public.agent_messages where body = 'guarda en notas: bloqueada'), 1::bigint, 'the message stays');
select set_config('app.ops_write', '1', true);
update public.pages set data = (data - 'locked') || '{"isDeleted":true}' where id = :'np';
alter table public.pages enable trigger pages_30_actor;
select set_config('app.ops_write', '', true);
select tests.say(:'owner'::uuid, :'ws'::uuid, 'guarda en notas: nueva', '61') as r61 \gset
select isnt(:'r61'::jsonb#>>'{outcome,page_id}', :'np', 'a trashed page is replaced');
select is((select page_id from public.note_pages where user_id = :'owner'::uuid), :'r61'::jsonb#>>'{outcome,page_id}', 'and the map follows');
select ok(exists (select 1 from public.private_pages where page_id = :'np'), 'the old page stays private in the trash');

select tests.set_human(:'owner'::uuid);
select is((public.set_notes_private(:'ws'::uuid, false))->>'private', 'false', 'the owner opens the notes');
select tests.reset_role();
select tests.set_human(:'viewer'::uuid);
select is((select count(*) from public.pages where id = :'r61'::jsonb#>>'{outcome,page_id}'), 1::bigint, 'and a member reads them');
select tests.reset_role();
select tests.set_human(:'owner'::uuid);
select is((public.set_notes_private(:'ws'::uuid, true))->>'private', 'true', 'and closes them again');
select is((public.my_notes_page(:'ws'::uuid))->>'private', 'true', 'the app can ask');
select tests.reset_role();
select tests.set_human(:'viewer'::uuid);
select is((select count(*) from public.pages where id = :'r61'::jsonb#>>'{outcome,page_id}'), 0::bigint, 'and it is hidden again');
select tests.reset_role();

-- G. Nothing here is a door for a model.
select ok(not has_function_privilege('authenticated', 'private.write_note(public.agent_messages, text, jsonb, jsonb, text)', 'execute'), 'nobody calls write_note');
select ok(not has_function_privilege('authenticated', 'private.handle_person_message(public.agent_messages, jsonb, text)', 'execute'), 'nor the handler');
select ok(not has_function_privilege('authenticated', 'private.note_command(text)', 'execute'), 'nor the detector');
select is(tests.sqlstate_of(format($q$insert into public.agent_messages (workspace_id, user_id, direction, channel, body) values (%L, %L, 'in', 'surface', 'x')$q$, :'ws', :'owner')), '', 'the superuser is the only direct writer');
select tests.set_human(:'owner'::uuid);
select is(tests.sqlstate_of(format($q$insert into public.agent_messages (workspace_id, user_id, direction, channel, body) values (%L, %L, 'in', 'surface', 'x')$q$, :'ws', :'owner')), '42501', 'no client writes the conversation');
select is(tests.sqlstate_of($q$update public.agent_messages set intent = '{"kind":"save"}'$q$), '42501', 'nor its intent');
select tests.reset_role();

select * from finish();
rollback;
