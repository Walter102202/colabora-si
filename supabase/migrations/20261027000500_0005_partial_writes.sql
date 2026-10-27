-- 0005_partial_writes: partial-write RPCs for people and agents (§IV.5.1 P1, §IV.5.3, §IV.5.4).
-- Agents never send Block or HTML: the RPC receives AgentBlockInput / AgentCellInput, builds escaped HTML here,
-- and applies block operations through private.apply_page_ops_core (D20). With an active run, every write
-- leaves an 'action' activity carrying the inverse operations the core returns.

-- ============ rendering helpers ============

-- Same scheme allowlist as the client safeHref: http, https, mailto, tel. No scheme = relative link, kept.
create or replace function private.safe_href(p_url text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_url, '')); v_probe text; v_scheme text;
begin
  if v = '' then return null; end if;
  v_probe := regexp_replace(v, '[\x01-\x20\x7f-\xa0]', '', 'g');
  v_scheme := lower(substring(v_probe from '^([a-zA-Z][a-zA-Z0-9+.-]*):'));
  if v_scheme is null then return v; end if;
  if v_scheme in ('http','https','mailto','tel') then return v; end if;
  return null;
end $$;

create or replace function private.escape_html(p_text text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
$$;

-- Plain text of a block's HTML: tags out, entities back.
create or replace function private.html_to_text(p_html text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(replace(
           regexp_replace(regexp_replace(coalesce(p_html, ''), '<br\s*/?>', E'\n', 'gi'), '<[^>]*>', '', 'g'),
           '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&nbsp;', ' '), '&amp;', '&');
$$;

-- AgentSpan[] -> the inline HTML subset sanitizeHtml admits.
create or replace function private.render_spans(p_spans jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_out text := ''; v_s jsonb; v_part text; v_href text; v_title text; v_name text;
begin
  if p_spans is null or p_spans = 'null'::jsonb then return ''; end if;
  if jsonb_typeof(p_spans) <> 'array' then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'spans'; end if;
  for v_s in select * from jsonb_array_elements(p_spans) loop
    if jsonb_typeof(v_s) = 'string' then
      v_part := private.escape_html(v_s #>> '{}');
    elsif jsonb_typeof(v_s) = 'object' and v_s ? 'text' then
      v_part := private.escape_html(v_s->>'text');
      if coalesce((v_s->>'code')::boolean, false) then v_part := '<code>' || v_part || '</code>'; end if;
      if coalesce((v_s->>'bold')::boolean, false) then v_part := '<strong>' || v_part || '</strong>'; end if;
      if coalesce((v_s->>'italic')::boolean, false) then v_part := '<em>' || v_part || '</em>'; end if;
      if coalesce((v_s->>'strike')::boolean, false) then v_part := '<s>' || v_part || '</s>'; end if;
      if coalesce((v_s->>'underline')::boolean, false) then v_part := '<u>' || v_part || '</u>'; end if;
      v_href := private.safe_href(v_s->>'href');
      if v_href is not null then v_part := '<a href="' || private.escape_html(v_href) || '">' || v_part || '</a>'; end if;
    elsif jsonb_typeof(v_s) = 'object' and v_s->>'mention' = 'page' then
      select coalesce(nullif(p.data->>'title', ''), 'Untitled') into v_title
        from public.pages p where p.id = v_s->>'pageId' and p.deleted_at is null;
      if not found then raise exception using errcode = 'PT422', message = 'unknown_page', detail = coalesce(v_s->>'pageId', ''); end if;
      v_part := '<a class="mention" data-page="' || private.escape_html(v_s->>'pageId') || '" href="/p/'
                || private.escape_html(v_s->>'pageId') || '">' || private.escape_html(v_title) || '</a>';
    elsif jsonb_typeof(v_s) = 'object' and v_s->>'mention' = 'person' then
      select coalesce((select a.name from public.agents a where a.auth_user_id = u.id), split_part(u.email, '@', 1)) into v_name
        from auth.users u where u.id::text = v_s->>'userId';
      if not found then raise exception using errcode = 'PT422', message = 'unknown_user', detail = coalesce(v_s->>'userId', ''); end if;
      v_part := '<span class="mention person-mention" data-user="' || private.escape_html(v_s->>'userId') || '">@'
                || private.escape_html(v_name) || '</span>';
    elsif jsonb_typeof(v_s) = 'object' and v_s ? 'equation' then
      v_part := '<span class="inline-eq" data-eq="' || private.escape_html(v_s->>'equation') || '">'
                || private.escape_html(v_s->>'equation') || '</span>';
    else
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'span';
    end if;
    v_out := v_out || v_part;
  end loop;
  return v_out;
end $$;

-- AgentBlockInput -> internal Block with a fresh id. Container and executable types are not allowed.
create or replace function private.render_block(p_block jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_type text := p_block->>'type'; v_indent int; v_out jsonb; v_url text; v_text text;
begin
  if jsonb_typeof(p_block) is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if v_type is null or v_type not in ('paragraph','heading1','heading2','heading3','todo','bulleted','numbered','toggle','quote',
                                      'callout','code','divider','equation','bookmark','image','file','page') then
    raise exception using errcode = 'PT422', message = 'block_type_not_allowed', detail = coalesce(v_type, '');
  end if;
  v_indent := coalesce((p_block->>'indent')::int, 0);
  if v_indent < 0 or v_indent > 6 then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'indent'; end if;
  if p_block ? 'key' and (p_block->>'key') !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'key';
  end if;
  if p_block ? 'color' and (p_block->>'color') not in ('default','gray','brown','orange','yellow','green','blue','purple','pink','red',
       'bg-gray','bg-brown','bg-orange','bg-yellow','bg-green','bg-blue','bg-purple','bg-pink','bg-red') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'color';
  end if;

  if v_type = 'code' then
    select coalesce(string_agg(case when jsonb_typeof(s) = 'string' then s #>> '{}' else s->>'text' end, ''), '') into v_text
      from jsonb_array_elements(coalesce(p_block->'spans', '[]'::jsonb)) s;
    v_out := jsonb_build_object('html', private.escape_html(v_text));
  elsif v_type in ('divider','equation','image','file','page') then
    v_out := jsonb_build_object('html', '');
  else
    v_out := jsonb_build_object('html', private.render_spans(p_block->'spans'));
  end if;

  if v_type in ('bookmark','image','file') then
    v_url := private.safe_href(p_block->>'url');
    if v_url is null then raise exception using errcode = 'PT422', message = 'unsafe_url'; end if;
  end if;
  if v_type = 'page' and not exists (select 1 from public.pages p where p.id = p_block->>'pageId' and p.deleted_at is null) then
    raise exception using errcode = 'PT422', message = 'unknown_page', detail = coalesce(p_block->>'pageId', '');
  end if;

  return jsonb_strip_nulls(v_out || jsonb_build_object(
    'id', replace(gen_random_uuid()::text, '-', ''),
    'type', v_type,
    'indent', v_indent,
    'color', p_block->>'color',
    'key', p_block->>'key',
    'checked', case when v_type = 'todo' then coalesce((p_block->>'checked')::boolean, false) end,
    'language', case when v_type = 'code' then left(p_block->>'language', 40) end,
    'icon', case when v_type = 'callout' then left(p_block->>'icon', 16) end,
    'url', v_url,
    'caption', case when v_type in ('image','file','bookmark') then left(p_block->>'caption', 500) end,
    'equation', case when v_type = 'equation' then coalesce(p_block->>'equation', '') end,
    'pageId', case when v_type = 'page' then p_block->>'pageId' end));
end $$;

-- ============ shared write context ============

-- The page an RPC writes: exists, not in the trash, not locked, writable by the caller. Agents pay the rate limit.
create or replace function private.pw_page(p_page_id text)
returns public.pages language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_agent uuid;
begin
  select * into v_page from public.pages where id = p_page_id and deleted_at is null;
  if not found or v_page.data is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if coalesce((v_page.data->>'locked')::boolean, false) then
    raise exception using errcode = 'PT423', message = 'page_locked',
      detail = jsonb_build_object('locked_by', v_page.last_edited_by)::text;
  end if;
  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
  end if;
  if not private.can_write_page(p_page_id, v_page.workspace_id) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  return v_page;
end $$;

-- Active run the write belongs to: the calling agent's working task on one of these pages, else its only active run.
create or replace function private.pw_run(p_pages text[])
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_run uuid;
begin
  if v_agent is null then return null; end if;
  select t.active_run_id into v_run from public.agent_tasks t join public.agent_runs r on r.id = t.active_run_id
   where r.agent_id = v_agent and t.state = 'working' and t.row_page_id = any (p_pages) limit 1;
  if v_run is null then
    select r.id into v_run from public.agent_runs r where r.agent_id = v_agent and r.status in ('running','waiting')
     and (select count(*) from public.agent_runs x where x.agent_id = v_agent and x.status in ('running','waiting')) = 1;
  end if;
  return v_run;
end $$;

create or replace function private.pw_activity(p_run uuid, p_body jsonb, p_inverse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype;
begin
  if p_run is null then return; end if;
  select * into v_r from public.agent_runs where id = p_run;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, inverse_ops, author_type, author_id)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), 'action', p_body, p_inverse, 'agent', v_r.agent_id);
end $$;

-- AgentCellInput -> stored cell value for one property. Returns {value, property}: property is the updated
-- definition when a select option had to be created, null otherwise.
create or replace function private.cell_value(p_prop jsonb, p_input jsonb, p_ws uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_type text := p_prop->>'type'; v_prop jsonb := null; v_names text[]; v_name text; v_ids jsonb := '[]'; v_opt text;
        v_url text; v_bad text;
begin
  if v_type in ('formula','rollup','createdTime','lastEditedTime','createdBy','lastEditedBy','id','agentStatus','agentDelegate','button') then
    raise exception using errcode = 'PT422', message = 'computed_property', detail = p_prop->>'name';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
  case v_type
    when 'text' then
      if jsonb_typeof(p_input->'text') <> 'string' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
      return jsonb_build_object('value', p_input->'text');
    when 'number' then
      if jsonb_typeof(p_input->'number') <> 'number' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
      return jsonb_build_object('value', p_input->'number');
    when 'checkbox' then
      if jsonb_typeof(p_input->'checkbox') <> 'boolean' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
      return jsonb_build_object('value', p_input->'checkbox');
    when 'date' then
      if coalesce(p_input->>'date', '') !~ '^\d{4}-\d{2}-\d{2}' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
      return jsonb_build_object('value', to_jsonb(left(p_input->>'date', 10)));
    when 'url' then
      v_url := private.safe_href(p_input->>'url');
      if v_url is null then raise exception using errcode = 'PT422', message = 'unsafe_url', detail = p_prop->>'name'; end if;
      return jsonb_build_object('value', to_jsonb(v_url));
    when 'email', 'phone' then
      if jsonb_typeof(p_input->v_type) <> 'string' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
      return jsonb_build_object('value', p_input->v_type);
    when 'select', 'status', 'multiSelect' then
      if v_type = 'multiSelect' then
        if jsonb_typeof(p_input->'multiSelect') <> 'array' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
        v_names := array(select jsonb_array_elements_text(p_input->'multiSelect'));
      else
        if jsonb_typeof(p_input->v_type) <> 'string' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
        v_names := array[p_input->>v_type];
      end if;
      v_prop := p_prop;
      foreach v_name in array v_names loop
        select o->>'id' into v_opt from jsonb_array_elements(coalesce(v_prop->'options', '[]'::jsonb)) o where lower(o->>'name') = lower(v_name) limit 1;
        if v_opt is null then
          v_opt := private.random_base62(12);
          v_prop := jsonb_set(v_prop, '{options}', coalesce(v_prop->'options', '[]'::jsonb)
                      || jsonb_build_array(jsonb_build_object('id', v_opt, 'name', v_name, 'color', 'default')));
        end if;
        v_ids := v_ids || to_jsonb(v_opt);
      end loop;
      return jsonb_build_object('value', case when v_type = 'multiSelect' then v_ids else v_ids->0 end,
                                'property', case when v_prop = p_prop then null else v_prop end);
    when 'relation', 'person', 'files' then
      if jsonb_typeof(p_input->v_type) <> 'array' then raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name'; end if;
      if v_type = 'relation' then
        select x into v_bad from jsonb_array_elements_text(p_input->'relation') x
         where not exists (select 1 from public.pages p where p.id = x and p.workspace_id = p_ws and p.deleted_at is null) limit 1;
        if v_bad is not null then raise exception using errcode = 'PT422', message = 'unknown_page', detail = v_bad; end if;
      elsif v_type = 'person' then
        select x into v_bad from jsonb_array_elements_text(p_input->'person') x
         where not exists (select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id::text = x)
           and not exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id::text = x) limit 1;
        if v_bad is not null then raise exception using errcode = 'PT422', message = 'unknown_user', detail = v_bad; end if;
      else
        select x into v_bad from jsonb_array_elements_text(p_input->'files') x
         where not exists (select 1 from public.files f where f.id = x and f.workspace_id = p_ws) limit 1;
        if v_bad is not null then raise exception using errcode = 'PT422', message = 'unknown_file', detail = v_bad; end if;
      end if;
      return jsonb_build_object('value', p_input->v_type);
    else
      raise exception using errcode = 'PT422', message = 'invalid_cell', detail = p_prop->>'name';
  end case;
end $$;

-- Resolves {propertyId or name: AgentCellInput} against a database into {cells, properties}: stored values per
-- property id and the property definitions that changed (new select options).
create or replace function private.resolve_cells(p_database jsonb, p_cells jsonb, p_ws uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key text; v_input jsonb; v_prop jsonb; v_res jsonb; v_cells jsonb := '{}'; v_props jsonb := '{}';
begin
  if jsonb_typeof(p_cells) is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'cells'; end if;
  for v_key, v_input in select * from jsonb_each(p_cells) loop
    select p into v_prop from jsonb_array_elements(coalesce(p_database->'properties', '[]'::jsonb)) p where p->>'id' = v_key;
    if v_prop is null then
      select p into v_prop from jsonb_array_elements(coalesce(p_database->'properties', '[]'::jsonb)) p where lower(p->>'name') = lower(v_key) limit 1;
    end if;
    if v_prop is null then raise exception using errcode = 'PT422', message = 'unknown_property', detail = v_key; end if;
    v_prop := coalesce(v_props->(v_prop->>'id'), v_prop);
    v_res := private.cell_value(v_prop, v_input, p_ws);
    v_cells := v_cells || jsonb_build_object(v_prop->>'id', v_res->'value');
    if v_res->'property' is not null and v_res->'property' <> 'null'::jsonb then
      v_props := v_props || jsonb_build_object(v_prop->>'id', v_res->'property');
    end if;
  end loop;
  return jsonb_build_object('cells', v_cells, 'properties', v_props);
end $$;

revoke execute on function private.safe_href(text) from public;
revoke execute on function private.escape_html(text) from public;
revoke execute on function private.html_to_text(text) from public;
revoke execute on function private.render_spans(jsonb) from public;
revoke execute on function private.render_block(jsonb) from public;
revoke execute on function private.pw_page(text) from public;
revoke execute on function private.pw_run(text[]) from public;
revoke execute on function private.pw_activity(uuid, jsonb, jsonb) from public;
revoke execute on function private.cell_value(jsonb, jsonb, uuid) from public;
revoke execute on function private.resolve_cells(jsonb, jsonb, uuid) from public;

-- ============ RPCs ============

create or replace function public.append_page_blocks(p_page_id text, p_blocks jsonb, p_after_block_id text default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_actor uuid := (select auth.uid()); v_run uuid;
        v_new jsonb := '[]'; v_ids text[] := '{}'; v_ops jsonb; v_prev text; v_res jsonb; v_receipt jsonb;
begin
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope='append_page_blocks' and key=p_idempotency_key and actor_id=v_actor;
    if found then return v_receipt; end if;
  end if;
  if jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks) = 0 or jsonb_array_length(p_blocks) > 200 then
    raise exception using errcode='PT400', message='invalid_input';
  end if;

  v_page := private.pw_page(p_page_id);
  v_run := private.pw_run(array[p_page_id]);
  if p_after_block_id is not null and not exists (
       select 1 from jsonb_array_elements(coalesce(v_page.data->'blocks','[]')) b where b->>'id' = p_after_block_id) then
    raise exception using errcode='PT404', message='block_not_found', detail=p_after_block_id;
  end if;

  -- AgentBlockInput -> Block (escape + safe_href inside render_block); rendered once so ids are stable.
  select jsonb_agg(r.blk order by r.i), array_agg(r.blk->>'id' order by r.i) into v_new, v_ids
    from (select private.render_block(b) as blk, i from jsonb_array_elements(p_blocks) with ordinality e(b, i)) r;

  -- one insert_block per block, chained after p_after_block_id (null = at the end: anchor = last block)
  v_prev := coalesce(p_after_block_id, (select b->>'id' from jsonb_array_elements(coalesce(v_page.data->'blocks','[]')) with ordinality e(b, o)
                                         order by o desc limit 1));
  select jsonb_agg(jsonb_build_object('op','insert_block','after', x.after, 'block', x.b) order by x.i) into v_ops
    from (select b, i, lag(b->>'id', 1, v_prev) over (order by i) as after
            from jsonb_array_elements(v_new) with ordinality e(b, i)) x;

  if v_run is not null then perform set_config('app.run_id', v_run::text, true); end if;
  v_res := private.apply_page_ops_core(p_page_id, v_ops, null);
  select * into v_page from public.pages where id = p_page_id;

  perform private.pw_activity(v_run,
    jsonb_build_object('op','append_blocks','page_id',p_page_id,'block_ids',to_jsonb(v_ids),'revision',v_page.revision,
                       'summary', 'Appended ' || cardinality(v_ids) || ' block(s)'),
    v_res->'inverse');

  v_receipt := jsonb_build_object('revision', v_page.revision, 'block_ids', to_jsonb(v_ids));
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('append_page_blocks', p_idempotency_key, v_actor, v_receipt);
  end if;
  return v_receipt;
end $$;

create or replace function public.edit_block_text(p_page_id text, p_block_id text, p_old_str text, p_new_str text,
  p_rev bigint default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_actor uuid := (select auth.uid()); v_run uuid; v_block jsonb; v_text text; v_count int;
        v_op jsonb; v_res jsonb; v_receipt jsonb;
begin
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope='edit_block_text' and key=p_idempotency_key and actor_id=v_actor;
    if found then return v_receipt; end if;
  end if;
  if coalesce(p_old_str, '') = '' or p_new_str is null then raise exception using errcode='PT400', message='invalid_input'; end if;

  v_page := private.pw_page(p_page_id);
  v_run := private.pw_run(array[p_page_id]);
  select b into v_block from jsonb_array_elements(coalesce(v_page.data->'blocks','[]')) b where b->>'id' = p_block_id;
  if v_block is null then raise exception using errcode='PT404', message='block_not_found', detail=p_block_id; end if;

  v_text := private.html_to_text(v_block->>'html');
  v_count := (length(v_text) - length(replace(v_text, p_old_str, ''))) / length(p_old_str);
  if v_count = 0 then raise exception using errcode='PT422', message='old_str_not_found'; end if;
  if v_count > 1 then raise exception using errcode='PT422', message='old_str_not_unique', detail=jsonb_build_object('count', v_count)::text; end if;

  v_op := jsonb_build_object('op','update_block','id',p_block_id,
                             'patch', jsonb_build_object('html', private.escape_html(replace(v_text, p_old_str, p_new_str))))
          || case when p_rev is not null then jsonb_build_object('rev', p_rev) else '{}'::jsonb end;
  if v_run is not null then perform set_config('app.run_id', v_run::text, true); end if;
  v_res := private.apply_page_ops_core(p_page_id, jsonb_build_array(v_op), null);

  perform private.pw_activity(v_run,
    jsonb_build_object('op','edit_block','page_id',p_page_id,'block_ids',jsonb_build_array(p_block_id),'revision',v_res->'revision',
                       'summary', 'Edited text of a block'),
    v_res->'inverse');
  v_receipt := jsonb_build_object('revision', v_res->'revision', 'rev', v_res->'results'->0->'rev');
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('edit_block_text', p_idempotency_key, v_actor, v_receipt);
  end if;
  return v_receipt;
end $$;

create or replace function public.update_block(p_page_id text, p_block_id text, p_patch jsonb, p_rev bigint default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_actor uuid := (select auth.uid()); v_run uuid; v_bad text; v_patch jsonb; v_url text;
        v_op jsonb; v_res jsonb; v_receipt jsonb;
begin
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope='update_block' and key=p_idempotency_key and actor_id=v_actor;
    if found then return v_receipt; end if;
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb then raise exception using errcode='PT400', message='invalid_input'; end if;
  select k into v_bad from jsonb_object_keys(p_patch) k
   where k not in ('checked','collapsed','language','color','indent','caption','url') limit 1;
  if v_bad is not null then raise exception using errcode='PT422', message='field_not_allowed', detail=v_bad; end if;
  if (p_patch ? 'checked' and jsonb_typeof(p_patch->'checked') <> 'boolean')
     or (p_patch ? 'collapsed' and jsonb_typeof(p_patch->'collapsed') <> 'boolean')
     or (p_patch ? 'indent' and (jsonb_typeof(p_patch->'indent') <> 'number' or (p_patch->>'indent')::numeric not in (0,1,2,3,4,5,6)))
     or (p_patch ? 'language' and jsonb_typeof(p_patch->'language') <> 'string')
     or (p_patch ? 'caption' and jsonb_typeof(p_patch->'caption') <> 'string')
     or (p_patch ? 'color' and coalesce(p_patch->>'color', '') not in ('default','gray','brown','orange','yellow','green','blue','purple','pink','red',
          'bg-gray','bg-brown','bg-orange','bg-yellow','bg-green','bg-blue','bg-purple','bg-pink','bg-red')) then
    raise exception using errcode='PT400', message='invalid_input';
  end if;
  v_patch := p_patch;
  if p_patch ? 'url' then
    v_url := private.safe_href(p_patch->>'url');
    if v_url is null then raise exception using errcode='PT422', message='unsafe_url'; end if;
    v_patch := v_patch || jsonb_build_object('url', v_url);
  end if;

  v_page := private.pw_page(p_page_id);
  v_run := private.pw_run(array[p_page_id]);
  if not exists (select 1 from jsonb_array_elements(coalesce(v_page.data->'blocks','[]')) b where b->>'id' = p_block_id) then
    raise exception using errcode='PT404', message='block_not_found', detail=p_block_id;
  end if;
  v_op := jsonb_build_object('op','update_block','id',p_block_id,'patch',v_patch)
          || case when p_rev is not null then jsonb_build_object('rev', p_rev) else '{}'::jsonb end;
  if v_run is not null then perform set_config('app.run_id', v_run::text, true); end if;
  v_res := private.apply_page_ops_core(p_page_id, jsonb_build_array(v_op), null);

  perform private.pw_activity(v_run,
    jsonb_build_object('op','edit_block','page_id',p_page_id,'block_ids',jsonb_build_array(p_block_id),'revision',v_res->'revision',
                       'summary', 'Updated block properties'),
    v_res->'inverse');
  v_receipt := jsonb_build_object('revision', v_res->'revision', 'rev', v_res->'results'->0->'rev');
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('update_block', p_idempotency_key, v_actor, v_receipt);
  end if;
  return v_receipt;
end $$;

create or replace function public.set_row_cells(p_db_page_id text, p_row_id text, p_cells jsonb, p_rev bigint default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_actor uuid := (select auth.uid()); v_run uuid; v_row jsonb; v_resolved jsonb;
        v_ops jsonb := '[]'; v_res jsonb; v_res_title jsonb; v_receipt jsonb; v_prop jsonb; v_key text; v_val jsonb; v_inverse jsonb;
begin
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope='set_row_cells' and key=p_idempotency_key and actor_id=v_actor;
    if found then return v_receipt; end if;
  end if;
  if jsonb_typeof(p_cells) is distinct from 'object' or p_cells = '{}'::jsonb then raise exception using errcode='PT400', message='invalid_input'; end if;

  v_page := private.pw_page(p_db_page_id);
  if not (v_page.data ? 'database') then raise exception using errcode='PT422', message='not_a_database'; end if;
  select r into v_row from jsonb_array_elements(coalesce(v_page.data->'database'->'rows','[]')) r where r->>'id' = p_row_id;
  if v_row is null then raise exception using errcode='PT404', message='row_not_found', detail=p_row_id; end if;
  v_run := private.pw_run(array[p_db_page_id, v_row->>'pageId']);

  v_resolved := private.resolve_cells(v_page.data->'database', p_cells, v_page.workspace_id);
  for v_prop in select value from jsonb_each(v_resolved->'properties') loop
    v_ops := v_ops || jsonb_build_object('op','db_prop_set','property',v_prop);
  end loop;
  for v_key, v_val in select * from jsonb_each(v_resolved->'cells') loop
    v_ops := v_ops || (jsonb_build_object('op','db_cell_set','rowId',p_row_id,'propertyId',v_key,'value',v_val)
                       || case when p_rev is not null then jsonb_build_object('rev', p_rev) else '{}'::jsonb end);
  end loop;

  if v_run is not null then perform set_config('app.run_id', v_run::text, true); end if;
  v_res := private.apply_page_ops_core(p_db_page_id, v_ops, null);
  v_inverse := v_res->'inverse';
  -- The title cell is mirrored on the row page, with its own revision.
  if v_resolved->'cells' ? 'title' and exists (select 1 from public.pages where id = v_row->>'pageId' and deleted_at is null) then
    v_res_title := private.apply_page_ops_core(v_row->>'pageId',
      jsonb_build_array(jsonb_build_object('op','set_page','patch',jsonb_build_object('title', v_resolved->'cells'->'title'))), null);
    v_inverse := v_inverse || jsonb_build_array(jsonb_build_object('page_id', v_row->>'pageId', 'ops', v_res_title->'inverse'));
  end if;

  perform private.pw_activity(v_run,
    jsonb_build_object('op','set_cells','page_id',p_db_page_id,'row_id',p_row_id,'revision',v_res->'revision',
                       'summary', 'Set ' || (select count(*) from jsonb_object_keys(v_resolved->'cells')) || ' cell(s)'),
    v_inverse);
  v_receipt := jsonb_build_object('revision', v_res->'revision',
    'rev', (select max((x->>'rev')::int) from jsonb_array_elements(v_res->'results') x));
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('set_row_cells', p_idempotency_key, v_actor, v_receipt);
  end if;
  return v_receipt;
end $$;

create or replace function public.add_row(p_db_page_id text, p_cells jsonb, p_blocks jsonb default '[]'::jsonb,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_actor uuid := (select auth.uid()); v_run uuid; v_resolved jsonb; v_cells jsonb;
        v_ops jsonb := '[]'; v_res jsonb; v_receipt jsonb; v_prop jsonb; v_props jsonb; v_next bigint;
        v_row_id text := private.random_base62(12); v_page_id text := private.random_base62(12); v_blocks jsonb := '[]';
        v_now bigint := (extract(epoch from now()) * 1000)::bigint; v_after text;
begin
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope='add_row' and key=p_idempotency_key and actor_id=v_actor;
    if found then return v_receipt; end if;
  end if;
  if jsonb_typeof(coalesce(p_blocks, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_blocks, '[]'::jsonb)) > 200 then
    raise exception using errcode='PT400', message='invalid_input';
  end if;

  v_page := private.pw_page(p_db_page_id);
  if not (v_page.data ? 'database') then raise exception using errcode='PT422', message='not_a_database'; end if;
  v_run := private.pw_run(array[p_db_page_id]);

  v_resolved := private.resolve_cells(v_page.data->'database', coalesce(p_cells, '{}'::jsonb), v_page.workspace_id);
  v_cells := v_resolved->'cells';
  v_props := v_resolved->'properties';
  -- id properties: next counter, as the client store assigns it.
  for v_prop in select p from jsonb_array_elements(coalesce(v_page.data->'database'->'properties','[]')) p where p->>'type' = 'id' loop
    v_next := coalesce((v_prop->>'nextId')::bigint,
                       (select coalesce(max((r->'cells'->>(v_prop->>'id'))::bigint), 0) + 1
                          from jsonb_array_elements(coalesce(v_page.data->'database'->'rows','[]')) r));
    v_cells := v_cells || jsonb_build_object(v_prop->>'id', v_next);
    v_props := v_props || jsonb_build_object(v_prop->>'id', v_prop || jsonb_build_object('nextId', v_next + 1));
  end loop;
  for v_prop in select value from jsonb_each(v_props) loop
    v_ops := v_ops || jsonb_build_object('op','db_prop_set','property',v_prop);
  end loop;
  select r->>'id' into v_after from jsonb_array_elements(coalesce(v_page.data->'database'->'rows','[]')) with ordinality e(r, o) order by o desc limit 1;
  v_ops := v_ops || jsonb_build_object('op','db_row_add','after',v_after,
    'row', jsonb_build_object('id', v_row_id, 'pageId', v_page_id, 'cells', v_cells, 'createdBy', v_actor, 'lastEditedBy', v_actor));

  if jsonb_array_length(coalesce(p_blocks, '[]'::jsonb)) > 0 then
    select jsonb_agg(private.render_block(b) order by i) into v_blocks from jsonb_array_elements(p_blocks) with ordinality e(b, i);
  end if;

  if v_run is not null then perform set_config('app.run_id', v_run::text, true); end if;
  perform set_config('app.ops_write', '1', true);
  insert into public.pages (id, workspace_id, parent_id, data)
  values (v_page_id, v_page.workspace_id, p_db_page_id, jsonb_build_object(
    'id', v_page_id, 'title', coalesce(v_cells->>'title', ''), 'icon', null, 'cover', null, 'coverPosition', 50,
    'parentId', p_db_page_id, 'blocks', v_blocks, 'isFavorite', false, 'isDeleted', false, 'fullWidth', false,
    'smallText', false, 'createdAt', v_now, 'updatedAt', v_now));
  v_res := private.apply_page_ops_core(p_db_page_id, v_ops, null);

  perform private.pw_activity(v_run,
    jsonb_build_object('op','add_row','page_id',p_db_page_id,'row_id',v_row_id,'revision',v_res->'revision',
                       'summary', 'Added a row'),
    jsonb_build_array(jsonb_build_object('op','delete_row','row_id',v_row_id), jsonb_build_object('op','soft_delete_page','page_id',v_page_id)));
  v_receipt := jsonb_build_object('row_id', v_row_id, 'page_id', v_page_id, 'revision', v_res->'revision');
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('add_row', p_idempotency_key, v_actor, v_receipt);
  end if;
  return v_receipt;
end $$;

revoke all on function public.append_page_blocks(text, jsonb, text, text) from public, anon;
revoke all on function public.edit_block_text(text, text, text, text, bigint, text) from public, anon;
revoke all on function public.update_block(text, text, jsonb, bigint, text) from public, anon;
revoke all on function public.set_row_cells(text, text, jsonb, bigint, text) from public, anon;
revoke all on function public.add_row(text, jsonb, jsonb, text) from public, anon;
grant execute on function public.append_page_blocks(text, jsonb, text, text) to authenticated;
grant execute on function public.edit_block_text(text, text, text, text, bigint, text) to authenticated;
grant execute on function public.update_block(text, text, jsonb, bigint, text) to authenticated;
grant execute on function public.set_row_cells(text, text, jsonb, bigint, text) to authenticated;
grant execute on function public.add_row(text, jsonb, jsonb, text) to authenticated;
