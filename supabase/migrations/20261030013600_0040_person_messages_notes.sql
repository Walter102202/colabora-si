-- 0040 · A person's messages to the workspace agent, and the page where "save this in notes" lands.
--
-- agent_messages is the conversation of one person with the workspace's platform agent, from any channel. The server
-- writes it: from the app with post_agent_message, from a chat channel with relay_person_message.
--
-- Saving a note takes two keys. When a message arrives, before any model sees it, private.note_command reads what the
-- person wrote and leaves the request on the message's row, where no agent can write; a message that was forwarded or
-- pasted is never read as a request. Then the agent, which understands the person, calls public.save_to_notes (0041) with
-- the id of that message, and the server writes only if that row carries the request. So a text that says "save this in
-- notes" inside a page, a forwarded audio or a model's answer can fool a model and still save nothing.
-- A note is not a lesson and not memory: nothing reads it back into an agent's context.

-- ============ tables ============

create table public.agent_messages (
  id           uuid primary key default gen_random_uuid(),
  -- The order of the conversation: a timestamp can tie, and "the last message" must not.
  seq          bigint generated always as identity,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Null while the workspace has no platform agent: the message still lands.
  agent_id     uuid references public.agents(id) on delete set null,
  direction    text not null check (direction in ('in','out')),
  channel      text not null check (channel in ('surface','telegram','whatsapp')),
  kind         text not null default 'text' check (kind in ('text','voice','system')),
  body         text not null check (char_length(body) between 1 and 20000),
  -- Not the person's own words: such a message is data and never a command.
  forwarded    boolean not null default false,
  pasted       boolean not null default false,
  -- One delivery of the channel. Scoped by person and channel below, so a key never reaches someone else's message.
  external_id  text check (external_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
  reply_to_id  uuid references public.agent_messages(id) on delete set null,
  -- Written by the server only.
  intent       jsonb,
  outcome      jsonb,
  needs_reply  boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index agent_messages_delivery_uidx on public.agent_messages (workspace_id, user_id, channel, external_id)
  where external_id is not null;
create index agent_messages_thread_idx on public.agent_messages (workspace_id, user_id, seq desc);

create table public.note_pages (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- By id, so a rename or a move finds it again. A trashed page is replaced by a new one.
  page_id      text not null references public.pages(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.saved_notes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  page_id       text not null references public.pages(id) on delete cascade,
  -- The message that asked. Unique: one message saves one note, however many times it is delivered.
  message_id    uuid not null unique references public.agent_messages(id) on delete cascade,
  source        jsonb not null,
  block_ids     text[] not null,
  day_block_id  text,
  day           date not null,
  created_at    timestamptz not null default now(),
  undone_at     timestamptz
);
create index saved_notes_user_idx on public.saved_notes (workspace_id, user_id, created_at desc);

alter table public.agent_messages enable row level security;
alter table public.note_pages enable row level security;
alter table public.saved_notes enable row level security;
revoke all on public.agent_messages, public.note_pages, public.saved_notes from anon, authenticated;
grant select on public.agent_messages, public.note_pages, public.saved_notes to authenticated;
grant all on public.agent_messages, public.note_pages, public.saved_notes to service_role;
-- Only the person, from the app: a chat session acting as them reads none of this.
create policy "own messages" on public.agent_messages for select to authenticated
  using (user_id = (select auth.uid()) and private.is_human_member(workspace_id) and private.jwt_client_id() is null);
create policy "own note page" on public.note_pages for select to authenticated
  using (user_id = (select auth.uid()) and private.is_human_member(workspace_id) and private.jwt_client_id() is null);
create policy "own notes" on public.saved_notes for select to authenticated
  using (user_id = (select auth.uid()) and private.is_human_member(workspace_id) and private.jwt_client_id() is null);
alter publication supabase_realtime add table public.agent_messages;

-- ============ what counts as asking ============

-- Reads one message the person wrote. Returns null, or
--   {kind: 'undo', lang}
--   {kind: 'save', lang, mode: 'reference', target: 'last' | 'page'}   "guarda esto en notas"
--   {kind: 'save', lang, mode: 'inline', text}                          "guarda en notas: comprar pan"
--   {kind: 'save', lang, mode: 'compound', text}                        "resume esto y guárdalo en notas"
-- The request opens the message on its first line, or closes it as a bare reference: "Perfecto, gracias. Guarda esto en
-- notas." Past tense, questions, negations and anything that names another place do not match. A miss only means the
-- agent reads the message as usual and has no way to save it.
create or replace function private.note_command(p_text text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  c_open   constant text := '^["''¿¡«“‘*_[:space:]]+';
  c_close  constant text := '["''»”’*_.!?…[:space:]]+$';
  c_gap    constant text := '[[:space:],]+';
  -- Imperative, infinitive and subjunctive, with and without the accent a transcription may drop. Never "guardé".
  c_verb_es constant text := '(?:'
    || 'gu[aá]rd(?:[aá]|e|ar|es|[aá]me|[aá]melo|[aá]mela|[aá]lo|[aá]la|arlo|arla|[eé]lo|[eé]la|[eé]me)'
    || '|an[oó]t(?:[aá]|e|ar|es|[aá]me|[aá]lo|[aá]la|arlo|arla|[eé]lo)'
    || '|ap[uú]nt(?:[aá]|e|ar|es|[aá]me|[aá]lo|[aá]la|arlo|arla|[eé]lo)'
    || '|agr[eé]g(?:[aá]|ar|[aá]lo|[aá]la|arlo|arla)|agregue|agregues'
    || '|a(?:ñ|n)[aá]d(?:e|ir|elo|ela|irlo|irla)'
    || '|p[oó]n(?:|lo|la|er|erlo|erla|me|melo|mela)'
    || '|m[eé]t(?:e|elo|ela|er|erlo)'
    || '|m[aá]nd(?:a|alo|ala|ar|arlo|ame)'
    || '|d[eé]j(?:a|alo|ala|ar|arlo|ame)'
    || '|me[[:space:]]+(?:guardas|guardai|anotas|anotai|apuntas|apuntai)'
    || ')';
  c_object_es constant text := '(?:esto|eso|esta|este|ese|esa|aquello|lo|la'
    || '|lo[[:space:]]+(?:[uú]ltimo|anterior)|lo[[:space:]]+que[[:space:]]+dije'
    || '|(?:el|este|ese)[[:space:]]+(?:[uú]ltimo[[:space:]]+)?(?:mensaje|audio|texto)'
    || '|(?:la|esta|esa)[[:space:]]+(?:[uú]ltima[[:space:]]+)?(?:respuesta|nota[[:space:]]+de[[:space:]]+voz|p[aá]gina))';
  c_where_es constant text := '(?:en|a|al|para|dentro[[:space:]]+de)[[:space:]]+(?:(?:mis|las|la|tus|el|los|nuestras)[[:space:]]+)?(?:notas?|notes?|apuntes)';
  c_verb_en constant text := '(?:save|safe|add|put|keep|store|write|jot|stick|drop)';
  c_object_en constant text := '(?:this|that|it|these|those|(?:the|this|that)[[:space:]]+(?:last[[:space:]]+)?(?:message|audio|reply|answer|text|voice[[:space:]]+note|page)|the[[:space:]]+above)';
  c_where_en constant text := '(?:in|to|into|on|under|as)[[:space:]]+(?:(?:a|my|the|our)[[:space:]]+)?notes?';
  c_keep_es constant text := '(?:gu[aá]rd(?:[aá]lo|[aá]la|arlo|arla|[aá]melo|[aá]mela|alo)|lo[[:space:]]+guard(?:as|es|ai)|an[oó]t(?:[aá]lo|arlo)|ap[uú]nt(?:[aá]lo|arlo))';
  c_after  constant text := '(?![[:alpha:]])(.*)$';
  v_raw  text := btrim(coalesce(p_text, ''), E' \t\r\n');
  v_first text; v_line text; v_more text; v_prev text; v_lang text; v_m text[]; v_tail text; v_word text; v_text text; v_end jsonb;
  v_polite boolean; v_question boolean; v_i int;
begin
  if v_raw = '' then return null; end if;
  if v_raw ~* '^/undo(@[a-z0-9_]+)?$' then return jsonb_build_object('kind', 'undo', 'lang', 'en'); end if;
  if v_raw ~* '^/deshacer(@[a-z0-9_]+)?$' then return jsonb_build_object('kind', 'undo', 'lang', 'es'); end if;
  if v_raw ~ '^(>|```)' then return null; end if;

  v_first := split_part(v_raw, E'\n', 1);
  v_more := btrim(substr(v_raw, char_length(v_first) + 2), E' \t\r\n');
  v_line := regexp_replace(btrim(v_first, E' \t\r'), c_open, '');
  v_question := v_line ~ '\?["''»”’*_[:space:]]*$';

  for v_i in 1..4 loop
    v_prev := v_line;
    v_line := regexp_replace(v_line, '^(oye|hey|hola|hi|ok|okay|ya|dale|bueno|porfa|porfis|por[[:space:]]+favor|please|pls|plz|colabora|muse|asistente)[[:space:],:;.!-]+', '', 'i');
    exit when v_line = v_prev;
  end loop;
  v_prev := v_line;
  v_line := regexp_replace(v_line, '^(me[[:space:]]+|te[[:space:]]+)?(puedes|podr[ií]as|podr[ií]a|quiero[[:space:]]+que|necesito[[:space:]]+que|te[[:space:]]+pido[[:space:]]+que|can[[:space:]]+you|could[[:space:]]+you|would[[:space:]]+you|will[[:space:]]+you|i[[:space:]]+want[[:space:]]+you[[:space:]]+to|i[[:space:]]+need[[:space:]]+you[[:space:]]+to)([[:space:]]+por[[:space:]]+favor|[[:space:]]+please)?' || c_gap, '', 'i');
  v_polite := v_line <> v_prev;
  -- "Me guardas esto en notas?" is a request. Any other question is not.
  if v_question and not v_polite and v_line !~* '^me[[:space:]]' then return null; end if;

  v_m := regexp_match(v_line, '^' || c_verb_es || '(?:' || c_gap || c_object_es || ')?' || c_gap || c_where_es || c_after, 'i');
  if v_m is not null then
    v_lang := 'es';
  else
    v_m := regexp_match(v_line, '^' || c_verb_en || '(?:' || c_gap || c_object_en || ')?(?:[[:space:]]+down)?' || c_gap || c_where_en || c_after, 'i');
    if v_m is not null then v_lang := 'en'; end if;
  end if;

  if v_m is null then
    -- The last sentence alone, only as a bare reference. What came before stays the person's: the agent says what "this" is.
    v_tail := substring(v_raw from '(?:[.!?…][[:space:]]+|\n[[:space:]]*)([^\n.!?…]+[.!?…]*)$');
    if v_tail is not null then
      v_end := private.note_command(v_tail);
      if v_end->>'mode' = 'reference' then return v_end; end if;
    end if;
    if v_more <> '' then return null; end if;
    -- A compound must start with the person's composition request, not negation, a report, or a past-tense statement.
    if v_line !~* '^(resume|resumir|res[uú]meme|traduce|traducir|trad[uú]ceme|escribe|escribir|redacta|redactar|crea|crear|summarize|summarise|translate|write|draft|create)[[:space:]]' then return null; end if;
    v_m := regexp_match(regexp_replace(v_line, c_close, ''), '^(.+?)' || c_gap || '(?:y|e)[[:space:]]+(?:luego[[:space:]]+|despu[eé]s[[:space:]]+)?' || c_keep_es
                        || c_gap || '(?:en|a)[[:space:]]+(?:(?:mis|las)[[:space:]]+)?notas?$', 'i');
    if v_m is not null then v_lang := 'es'; else
      v_lang := 'en';
      v_m := regexp_match(regexp_replace(v_line, c_close, ''), '^(.+?)' || c_gap || '(?:and)[[:space:]]+(?:then[[:space:]]+)?(?:save|put|add|keep)'
                        || c_gap || '(?:it|this|that|the[[:space:]]+result)' || c_gap || '(?:in|to|into)[[:space:]]+(?:(?:my|the)[[:space:]]+)?notes?$', 'i');
    end if;
    -- The save clause must be outside the text being translated/rewritten. Apostrophes inside words are not quotes.
    if v_m is not null and char_length(v_m[1]) between 3 and 500
       and regexp_count(v_m[1], '"') % 2 = 0 and regexp_count(v_m[1], '`') % 2 = 0
       and regexp_count(v_m[1], '[“«]') = regexp_count(v_m[1], '[”»]')
       and regexp_count(v_m[1], '(^|[[:space:]])''') = regexp_count(v_m[1], '''([[:space:]]|$)')
    then return jsonb_build_object('kind', 'save', 'lang', v_lang, 'mode', 'compound', 'text', v_m[1]); end if;
    return null;
  end if;

  v_tail := btrim(v_m[1], E' \t\r');
  if v_tail ~* '^["''»”’*_.,;:!?…[:space:]-]*(por[[:space:]]+favor|porfa|porfis|please|pls|plz|gracias|thanks|thank[[:space:]]+you)?["''»”’*_.,;:!?…[:space:]-]*$' then
    v_tail := '';
  elsif v_tail ~ '^[:;,.–—-]' then
    v_tail := btrim(regexp_replace(v_tail, '^[:;,.–—-]+', ''), E' \t\r');
  elsif v_tail ~* '^(que|that)[[:space:]]+' then
    v_tail := regexp_replace(v_tail, '^(que|that)[[:space:]]+', '', 'i');
  else
    -- "en notas del proyecto", "in notes about X": another place, or a sentence that goes on. The agent reads it.
    v_word := lower(substring(v_tail from '^[^[:space:]]+'));
    if v_word in ('del','de','sobre','para','en','con','y','o','pero','por','al','a','of','for','about','on','in','and','or','but','from','at','to','app') then
      return null;
    end if;
  end if;

  v_text := btrim(concat_ws(E'\n', nullif(v_tail, ''), nullif(v_more, '')), E' \t\r\n');
  if v_text <> '' then
    return jsonb_build_object('kind', 'save', 'lang', v_lang, 'mode', 'inline', 'text', v_text);
  end if;
  return jsonb_build_object('kind', 'save', 'lang', v_lang, 'mode', 'reference',
    'target', case when v_line ~* '(esta|la)[[:space:]]+p[aá]gina|(this|the)[[:space:]]+page' then 'page' else 'last' end);
end $$;
revoke all on function private.note_command(text) from public, anon, authenticated;

-- ============ helpers ============

create or replace function private.safe_tz(p_tz text)
returns text language plpgsql stable set search_path = '' as $$
declare v_ignored timestamp;
begin
  if p_tz is null or p_tz !~ '^[A-Za-z0-9_+/-]{1,64}$' then return 'UTC'; end if;
  v_ignored := now() at time zone p_tz;
  return p_tz;
exception when others then
  return 'UTC';
end $$;
revoke all on function private.safe_tz(text) from public, anon, authenticated;

create or replace function private.note_page_live(p_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pages p where p.id = p_id and p.deleted_at is null and p.data is not null
                  and coalesce((p.data->>'isDeleted')::boolean, false) = false);
$$;
revoke all on function private.note_page_live(text) from public, anon, authenticated;

-- The person's notes page: created once, private, found by id. The advisory lock makes two first saves one page.
create or replace function private.ensure_note_page(p_ws uuid, p_user uuid, p_lang text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id text; v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint; v_about jsonb; v_es boolean := p_lang = 'es';
begin
  perform pg_advisory_xact_lock(hashtextextended('notes:' || p_ws::text || ':' || p_user::text, 0));
  select page_id into v_id from public.note_pages where workspace_id = p_ws and user_id = p_user;
  if v_id is not null and private.note_page_live(v_id) then return v_id; end if;
  v_id := replace(gen_random_uuid()::text, '-', '');
  v_about := private.render_block(jsonb_build_object('type', 'callout', 'icon', '🔒', 'key', 'notes:about', 'spans', jsonb_build_array(
    case when v_es then 'Solo tú ves esta página. Aquí llega lo que le pides guardar al agente.'
         else 'Only you see this page. What you ask the agent to save lands here.' end)));
  perform set_config('app.ops_write', '1', true);
  insert into public.pages (id, workspace_id, parent_id, data)
  values (v_id, p_ws, null, jsonb_build_object(
    'id', v_id, 'title', case when v_es then 'Notas' else 'Notes' end, 'icon', '🗒️', 'cover', null, 'coverPosition', 50,
    'parentId', null, 'blocks', jsonb_build_array(v_about), 'isFavorite', false, 'isDeleted', false, 'fullWidth', false,
    'smallText', false, 'createdAt', v_now, 'updatedAt', v_now));
  insert into public.private_pages (page_id, workspace_id, owner_user_id, root_page_id) values (v_id, p_ws, p_user, v_id);
  insert into public.note_pages (workspace_id, user_id, page_id) values (p_ws, p_user, v_id)
    on conflict (workspace_id, user_id) do update set page_id = excluded.page_id;
  update public.workspaces set root_order = coalesce(root_order, '[]'::jsonb) || to_jsonb(v_id) where id = p_ws;
  perform set_config('app.ops_write', '', true);
  return v_id;
end $$;
revoke all on function private.ensure_note_page(uuid, uuid, text) from public, anon, authenticated;

-- One line of attribution under the note: when, from where and how it came.
create or replace function private.note_meta(p_lang text, p_at timestamp, p_channel text, p_source jsonb)
returns text language sql immutable set search_path = '' as $$
  select concat_ws(' · ', to_char(p_at, 'HH24:MI'),
    case p_channel when 'telegram' then 'Telegram' when 'whatsapp' then 'WhatsApp' else 'Chat' end,
    case p_source->>'kind'
      when 'voice' then case when p_lang = 'es' then 'nota de voz' else 'voice note' end
      when 'reply' then case when p_lang = 'es' then 'respuesta del agente' else 'agent reply' end
      when 'composed' then case when p_lang = 'es' then 'escrito por el agente' else 'written by the agent' end
      when 'selection' then case when p_lang = 'es' then 'selección' else 'selection' end
      when 'quote' then case when p_lang = 'es' then 'mensaje citado' else 'quoted message' end
      when 'page' then case when p_lang = 'es' then 'página' else 'page' end
      else null end,
    case when coalesce((p_source->>'forwarded')::boolean, false) then case when p_lang = 'es' then 'reenviado' else 'forwarded' end end);
$$;
revoke all on function private.note_meta(text, timestamp, text, jsonb) from public, anon, authenticated;

-- Writes one note under today's heading, newest first. p_spans is the note's body as AgentBlockInput spans per line.
create or replace function private.write_note(p_msg public.agent_messages, p_lang text, p_lines jsonb, p_source jsonb, p_tz text)
returns public.saved_notes language plpgsql security definer set search_path = '' as $$
declare v_page text; v_data jsonb; v_id uuid := gen_random_uuid(); v_local timestamp; v_day date; v_head text; v_after text;
        v_key text; v_blocks jsonb := '[]'; v_ids text[]; v_ops jsonb := '[]'; v_block jsonb; v_row public.saved_notes%rowtype; v_day_new jsonb;
begin
  v_page := private.ensure_note_page(p_msg.workspace_id, p_msg.user_id, p_lang);
  select data into v_data from public.pages where id = v_page for update;
  if coalesce((v_data->>'locked')::boolean, false) then raise exception using errcode = 'PT423', message = 'page_locked'; end if;
  v_local := now() at time zone private.safe_tz(p_tz);
  v_day := v_local::date;
  v_key := 'note:' || v_id::text;
  select b->>'id' into v_head from jsonb_array_elements(coalesce(v_data->'blocks', '[]')) b where b->>'key' = 'notes:day:' || v_day::text limit 1;
  v_after := coalesce(v_head, (select b->>'id' from jsonb_array_elements(coalesce(v_data->'blocks', '[]')) b where b->>'key' = 'notes:about' limit 1));
  if v_head is null then
    v_day_new := private.render_block(jsonb_build_object('type', 'heading3', 'key', 'notes:day:' || v_day::text, 'spans', jsonb_build_array(v_day::text)));
    v_head := v_day_new->>'id';
    v_ops := v_ops || jsonb_build_object('op', 'insert_block', 'after', v_after, 'block', v_day_new);
    v_after := v_head;
  end if;
  for v_block in select value from jsonb_array_elements(p_lines) loop
    v_block := private.render_block(jsonb_build_object('type', 'paragraph', 'key', v_key, 'spans', v_block));
    v_blocks := v_blocks || v_block;
    v_ops := v_ops || jsonb_build_object('op', 'insert_block', 'after', v_after, 'block', v_block);
    v_after := v_block->>'id';
  end loop;
  v_block := private.render_block(jsonb_build_object('type', 'paragraph', 'key', v_key, 'color', 'gray', 'indent', 1, 'spans', jsonb_build_array(
    private.note_meta(p_lang, v_local, p_msg.channel, p_source))));
  v_blocks := v_blocks || v_block;
  v_ops := v_ops || jsonb_build_object('op', 'insert_block', 'after', v_after, 'block', v_block);
  perform private.apply_page_ops_core(v_page, v_ops, null);
  select coalesce(array_agg(b->>'id'), '{}') into v_ids from jsonb_array_elements(v_blocks) b;
  insert into public.saved_notes (id, workspace_id, user_id, page_id, message_id, source, block_ids, day_block_id, day)
  values (v_id, p_msg.workspace_id, p_msg.user_id, v_page, p_msg.id, p_source, v_ids, v_head, v_day)
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.write_note(public.agent_messages, text, jsonb, jsonb, text) from public, anon, authenticated;

-- Plain text to one line of spans per non-empty line. At most 200 lines: render and apply take 200 ops per call.
create or replace function private.note_lines(p_text text)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(l) order by o), '[]'::jsonb) from (
    select l, o from regexp_split_to_table(p_text, E'\r?\n') with ordinality t(l, o) where btrim(l) <> '' order by o limit 190
  ) x;
$$;
revoke all on function private.note_lines(text) from public, anon, authenticated;

-- The text a reference points at, by a rule a test can follow. Returns {text, source} or {problem}.
--   1. A quoted message and a selection together are ambiguous.
--   2. Else the quoted message, else the selection.
--   3. "This page" saves a link to the page open in the app.
--   4. Else the last message of the conversation, from either side, if it is under 30 minutes old.
create or replace function private.note_target(p_msg public.agent_messages, p_cmd jsonb, p_context jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_quote text := nullif(btrim(coalesce(p_context->>'quote_text', '')), ''); v_sel text := nullif(btrim(coalesce(p_context#>>'{selection,text}', '')), '');
        v_page text; v_ws uuid; v_prev public.agent_messages%rowtype; v_title text;
begin
  if (p_context->>'quote_missing')::boolean is true then return jsonb_build_object('problem', 'no_target'); end if;
  if p_context ? 'quote_message_id' then
    select body into v_quote from public.agent_messages
     where id = (p_context->>'quote_message_id')::uuid and workspace_id = p_msg.workspace_id and user_id = p_msg.user_id;
  end if;
  if v_quote is not null and v_sel is not null then return jsonb_build_object('problem', 'ambiguous'); end if;
  if v_quote is not null then return jsonb_build_object('text', left(v_quote, 20000), 'source', jsonb_build_object('kind', 'quote')); end if;
  if v_sel is not null then
    v_page := p_context#>>'{selection,page_id}';
    select workspace_id into v_ws from public.pages where id = v_page and deleted_at is null;
    if v_ws is distinct from p_msg.workspace_id or not private.can_read_page(v_page, v_ws) then return jsonb_build_object('problem', 'no_target'); end if;
    return jsonb_build_object('text', left(v_sel, 20000), 'source', jsonb_build_object('kind', 'selection', 'page_id', v_page));
  end if;
  if p_cmd->>'target' = 'page' then
    v_page := p_context->>'page_id';
    select workspace_id, coalesce(nullif(data->>'title', ''), 'Untitled') into v_ws, v_title from public.pages where id = v_page and deleted_at is null;
    if v_page is null or v_ws is distinct from p_msg.workspace_id or not private.can_read_page(v_page, v_ws) then return jsonb_build_object('problem', 'no_target'); end if;
    return jsonb_build_object('page_id', v_page, 'text', v_title, 'source', jsonb_build_object('kind', 'page', 'page_id', v_page));
  end if;
  select * into v_prev from public.agent_messages
   where workspace_id = p_msg.workspace_id and user_id = p_msg.user_id and seq < p_msg.seq and kind <> 'system'
     and created_at > p_msg.created_at - interval '30 minutes'
     and coalesce(intent->>'kind', '') <> 'save'
   order by seq desc limit 1;
  if v_prev.id is null then return jsonb_build_object('problem', 'no_target'); end if;
  return jsonb_build_object('text', v_prev.body, 'source', jsonb_build_object(
    'kind', case when v_prev.direction = 'out' then 'reply' when v_prev.kind = 'voice' then 'voice' else 'message' end,
    'message_id', v_prev.id, 'forwarded', v_prev.forwarded));
end $$;
revoke all on function private.note_target(public.agent_messages, jsonb, jsonb) from public, anon, authenticated;

create or replace function private.undo_note_core(p_note public.saved_notes)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ops jsonb;
begin
  if p_note.undone_at is not null then return false; end if;
  update public.saved_notes set undone_at = now() where id = p_note.id;
  update public.agent_messages set outcome = outcome || '{"kind":"note_undone"}'::jsonb
   where workspace_id = p_note.workspace_id and user_id = p_note.user_id and outcome->>'note_id' = p_note.id::text;
  if not private.note_page_live(p_note.page_id) then return true; end if;
  select coalesce(jsonb_agg(jsonb_build_object('op', 'delete_block', 'id', id)), '[]'::jsonb) into v_ops from unnest(p_note.block_ids) id;
  if not exists (select 1 from public.saved_notes n where n.user_id = p_note.user_id and n.workspace_id = p_note.workspace_id
                  and n.day_block_id = p_note.day_block_id and n.undone_at is null) then
    v_ops := v_ops || jsonb_build_object('op', 'delete_block', 'id', p_note.day_block_id);
  end if;
  perform private.apply_page_ops_core(p_note.page_id, v_ops, null);
  return true;
end $$;
revoke all on function private.undo_note_core(public.saved_notes) from public, anon, authenticated;

-- What the server answers a person: stored as an outgoing message, so the app and the channel show the same thing.
create or replace function private.say(p_msg public.agent_messages, p_body text, p_outcome jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_messages (workspace_id, user_id, agent_id, direction, channel, kind, body, reply_to_id, outcome)
  values (p_msg.workspace_id, p_msg.user_id, p_msg.agent_id, 'out', p_msg.channel, 'system', p_body, p_msg.id, p_outcome);
end $$;
revoke all on function private.say(public.agent_messages, text, jsonb) from public, anon, authenticated;

-- A message the server just stored. /undo is answered here, with no model. Anything else goes to the agent. A request
-- to save stays on the row with what it points at, resolved now and as the sender, because can_read_page would answer
-- for the agent later on. The agent saves it through save_to_notes (0041) and this row is what the server checks.
create or replace function private.handle_person_message(p_msg public.agent_messages, p_context jsonb, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cmd jsonb; v_es boolean; v_note public.saved_notes%rowtype; v_outcome jsonb; v_target jsonb;
begin
  if not p_msg.forwarded and not p_msg.pasted then v_cmd := private.note_command(p_msg.body); end if;

  if v_cmd->>'kind' = 'undo' then
    v_es := v_cmd->>'lang' = 'es';
    update public.agent_messages set intent = v_cmd where id = p_msg.id;
    select * into v_note from public.saved_notes
     where workspace_id = p_msg.workspace_id and user_id = p_msg.user_id and undone_at is null and created_at > now() - interval '1 hour'
     order by created_at desc limit 1 for update;
    if v_note.id is null then
      v_outcome := jsonb_build_object('kind', 'nothing_to_undo');
      perform private.say(p_msg, case when v_es then 'No hay una nota reciente para deshacer.' else 'There is no recent note to undo.' end, v_outcome);
    else
      perform private.undo_note_core(v_note);
      v_outcome := jsonb_build_object('kind', 'note_undone', 'note_id', v_note.id, 'page_id', v_note.page_id);
      perform private.say(p_msg, case when v_es then 'Listo, quité esa nota.' else 'Done, I removed that note.' end, v_outcome);
    end if;
    update public.agent_messages set outcome = v_outcome where id = p_msg.id;
    return v_outcome;
  end if;

  if v_cmd->>'kind' = 'save' then
    v_target := case v_cmd->>'mode'
      when 'inline' then jsonb_build_object('text', v_cmd->>'text', 'source', jsonb_build_object('kind', case when p_msg.kind = 'voice' then 'voice' else 'message' end))
      when 'compound' then '{"compose":true}'::jsonb
      else private.note_target(p_msg, v_cmd, p_context) end;
    v_cmd := v_cmd || jsonb_strip_nulls(jsonb_build_object('resolved', v_target, 'tz', p_tz));
  end if;
  v_outcome := jsonb_build_object('kind', 'for_agent');
  update public.agent_messages set intent = v_cmd, needs_reply = true, outcome = v_outcome where id = p_msg.id;
  return v_outcome;
end $$;
revoke all on function private.handle_person_message(public.agent_messages, jsonb, text) from public, anon, authenticated;

-- Plug: 0042 replaces it. A voice message names the clip it came from, and the clip can change what the message is.
create or replace function private.bind_voice_clip(p_clip uuid, p_msg public.agent_messages)
returns public.agent_messages language plpgsql security definer set search_path = '' as $$
begin
  if p_clip is not null then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'voice clip'; end if;
  return p_msg;
end $$;
revoke all on function private.bind_voice_clip(uuid, public.agent_messages) from public, anon, authenticated;

-- Stores one delivery. A repeat answers with what the first one did, whatever its body says.
create or replace function private.store_person_message(p_ws uuid, p_user uuid, p_agent uuid, p_channel text, p_external text, p_body text,
  p_kind text, p_forwarded boolean, p_pasted boolean, p_clip uuid, p_context jsonb, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.agent_messages%rowtype; v_old public.agent_messages%rowtype; v_outcome jsonb; v_reply text;
begin
  if p_body is null or btrim(p_body) = '' or char_length(p_body) > 20000 or p_kind is null or p_kind not in ('text','voice') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'body';
  end if;
  insert into public.agent_messages (workspace_id, user_id, agent_id, direction, channel, kind, body, forwarded, pasted, external_id)
  values (p_ws, p_user, p_agent, 'in', p_channel, p_kind, p_body, coalesce(p_forwarded, false), coalesce(p_pasted, false), p_external)
  on conflict (workspace_id, user_id, channel, external_id) where external_id is not null do nothing
  returning * into v_msg;
  if v_msg.id is null then
    select * into v_old from public.agent_messages
     where workspace_id = p_ws and user_id = p_user and channel = p_channel and external_id = p_external;
    return jsonb_build_object('message_id', v_old.id, 'duplicate', true, 'outcome', v_old.outcome);
  end if;
  v_msg := private.bind_voice_clip(p_clip, v_msg);
  v_outcome := private.handle_person_message(v_msg, p_context, p_tz);
  select body into v_reply from public.agent_messages where reply_to_id = v_msg.id and direction = 'out' order by seq desc limit 1;
  return jsonb_strip_nulls(jsonb_build_object('message_id', v_msg.id, 'duplicate', false, 'outcome', v_outcome, 'reply', v_reply));
end $$;
revoke all on function private.store_person_message(uuid, uuid, uuid, text, text, text, text, boolean, boolean, uuid, jsonb, text) from public, anon, authenticated;

-- ============ RPCs ============

-- A person writes to the workspace agent from the app. p_context: {pasted, tz, page_id, selection: {page_id, text},
-- quote_message_id}. p_client_id is the retry key of this send.
create or replace function public.post_agent_message(p_workspace_id uuid, p_body text, p_client_id uuid,
  p_context jsonb default '{}'::jsonb, p_voice_clip_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_a public.agents%rowtype; v_recent int; v_ctx jsonb := coalesce(p_context, '{}'::jsonb);
begin
  if private.principal_type() <> 'human' or v_uid is null then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if not private.is_human_member(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if p_client_id is null or jsonb_typeof(v_ctx) <> 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if v_ctx ? 'quote_message_id' and coalesce(v_ctx->>'quote_message_id', '') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'quote_message_id';
  end if;
  v_a := private.platform_agent(p_workspace_id);
  if v_a.id is not null then perform private.check_rate(v_a.id); end if;
  select count(*) into v_recent from public.agent_messages
   where workspace_id = p_workspace_id and user_id = v_uid and direction = 'in' and created_at > now() - interval '1 minute';
  if v_recent >= 30 then raise exception using errcode = 'PT429', message = 'rate_limited', detail = '{"retry_after_s":60}'; end if;
  return private.store_person_message(p_workspace_id, v_uid, v_a.id, 'surface', 'surface:' || p_client_id::text, p_body,
    case when p_voice_clip_id is null then 'text' else 'voice' end, false, coalesce((v_ctx->>'pasted')::boolean, false),
    p_voice_clip_id, v_ctx, v_ctx->>'tz');
end $$;
revoke all on function public.post_agent_message(uuid, text, uuid, jsonb, uuid) from public, anon;
grant execute on function public.post_agent_message(uuid, text, uuid, jsonb, uuid) to authenticated;

-- Who a chat channel speaks for. The smallest pairing: the owner chat set on the agent's host belongs to the agent's
-- sponsor. A former member fails closed. Multi-person pairing replaces this function.
create or replace function private.channel_person(p_agent public.agents, p_channel text, p_chat_id text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  if p_channel <> 'telegram' or p_chat_id !~ '^-?[0-9]{1,20}$' then return null; end if;
  if not private.is_workspace_member_user(p_agent.workspace_id, p_agent.sponsor_user_id) then return null; end if;
  return p_agent.sponsor_user_id;
end $$;
revoke all on function private.channel_person(public.agents, text, text) from public, anon, authenticated;

-- The platform agent's runtime hands over one message a person sent on a chat channel. It sets p_forwarded from the
-- channel's own metadata. This is runtime code, not a model: REQUEST_TOOLS keeps the tool away from the model and only
-- the platform agent gets past this check.
create or replace function public.relay_person_message(p_chat_id text, p_message_id bigint, p_body text, p_kind text default 'text',
  p_forwarded boolean default false, p_quote_text text default null, p_voice_clip_id uuid default null, p_timezone text default null,
  p_channel text default 'telegram', p_quote_message_id bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_a public.agents%rowtype; v_user uuid; v_quote uuid; v_ctx jsonb;
begin
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  v_id := private.current_agent_id();
  if v_id is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
  select * into v_a from public.agents where id = v_id;
  if not v_a.is_platform then raise exception using errcode = 'PT403', message = 'platform_only'; end if;
  perform private.check_rate(v_id);
  if coalesce(p_message_id, 0) <= 0 then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'message_id'; end if;
  v_user := private.channel_person(v_a, p_channel, p_chat_id);
  if v_user is null then raise exception using errcode = 'PT403', message = 'not_linked'; end if;
  v_ctx := jsonb_strip_nulls(jsonb_build_object('quote_text', p_quote_text));
  -- A reply points at something. If it has no text and it is not a message we know, the last message is not a guess we make.
  if p_quote_message_id is not null then
    select id into v_quote from public.agent_messages
     where workspace_id = v_a.workspace_id and user_id = v_user and channel = p_channel and external_id = p_chat_id || ':' || p_quote_message_id::text;
    if v_quote is not null then v_ctx := v_ctx || jsonb_build_object('quote_message_id', v_quote);
    elsif p_quote_text is null then v_ctx := v_ctx || '{"quote_missing":true}'::jsonb;
    end if;
  end if;
  return private.store_person_message(v_a.workspace_id, v_user, v_id, p_channel, p_chat_id || ':' || p_message_id::text, p_body, p_kind,
    p_forwarded, false, p_voice_clip_id, v_ctx, p_timezone);
end $$;
revoke all on function public.relay_person_message(text, bigint, text, text, boolean, text, uuid, text, text, bigint) from public, anon;
grant execute on function public.relay_person_message(text, bigint, text, text, boolean, text, uuid, text, text, bigint) to authenticated;

-- The app's "Undo". Idempotent. From a chat channel the same thing is /undo.
create or replace function public.undo_note(p_note_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_note public.saved_notes%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_note from public.saved_notes where id = p_note_id and user_id = (select auth.uid()) for update;
  if not found or not private.is_human_member(v_note.workspace_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  perform private.undo_note_core(v_note);
  return jsonb_build_object('note_id', v_note.id, 'undone', true);
end $$;
revoke all on function public.undo_note(uuid) from public, anon;
grant execute on function public.undo_note(uuid) to authenticated;

-- The app's "Open notes": finds or creates the page. Returns its id and whether it is private.
create or replace function public.my_notes_page(p_workspace_id uuid, p_lang text default 'es')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if not private.is_human_member(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  v_id := private.ensure_note_page(p_workspace_id, (select auth.uid()), case when p_lang = 'en' then 'en' else 'es' end);
  return jsonb_build_object('page_id', v_id, 'private', exists (select 1 from public.private_pages where page_id = v_id));
end $$;
revoke all on function public.my_notes_page(uuid, text) from public, anon;
grant execute on function public.my_notes_page(uuid, text) to authenticated;

-- The owner opens their notes to the workspace, or closes them again. Applies to the whole tree of the page.
create or replace function public.set_notes_private(p_workspace_id uuid, p_private boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if not private.is_human_member(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  select page_id into v_id from public.note_pages where workspace_id = p_workspace_id and user_id = v_uid;
  if v_id is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if coalesce(p_private, true) then
    insert into public.private_pages (page_id, workspace_id, owner_user_id, root_page_id)
    select id, p_workspace_id, v_uid, v_id from private.page_subtree(v_id) id on conflict (page_id) do nothing;
  else
    delete from public.private_pages where root_page_id = v_id;
  end if;
  perform private.audit(p_workspace_id, 'notes.visibility', jsonb_build_object('page_id', v_id, 'private', coalesce(p_private, true)));
  return jsonb_build_object('page_id', v_id, 'private', coalesce(p_private, true));
end $$;
revoke all on function public.set_notes_private(uuid, boolean) from public, anon;
grant execute on function public.set_notes_private(uuid, boolean) to authenticated;
