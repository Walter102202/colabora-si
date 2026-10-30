-- 0029 · OAuth session links: a chat connected "as an agent" is that agent for the whole request.
--
-- A chat app signs in with OAuth as a person, so its token carries the person's sub plus a client_id. When the
-- person picked an agent on the consent screen, agent_oauth_links says which one. Patching each RPC and policy would
-- leave the person's reach open wherever one was missed, so the identity changes in one place instead: PostgREST runs
-- private.apply_session_link before every request, and a linked token continues as the agent's claims. Everything
-- after that (RLS, humans_only, rate limits, attribution) sees a normal agent. `via_user` keeps who connected it.
--
-- The hook covers the Data API only. Storage and Realtime still read the person's claims; the MCP tools reach Storage
-- after a read through the Data API, so the agent's grants decide there too.

-- PostgREST calls the hook as the request's role, and without usage on this schema every service-role call fails.
grant usage on schema private to service_role;

create or replace function private.apply_session_link()
returns void language plpgsql security definer set search_path = '' as $$
declare v_claims jsonb; v_user uuid; v_client text; v_l public.agent_oauth_links%rowtype; v_a public.agents%rowtype;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_client := nullif(v_claims->>'client_id', '');
  if v_client is null then return; end if;
  v_user := (v_claims->>'sub')::uuid;
  select * into v_l from public.agent_oauth_links where user_id = v_user and client_id = v_client;
  if not found then return; end if;
  -- A disconnected chat is refused at once, not when its token expires, and never falls back to the person.
  if v_l.revoked_at is not null then
    raise sqlstate 'PGRST' using
      message = json_build_object('code', 'link_revoked', 'message', 'link_revoked', 'details', null, 'hint', null)::text,
      detail = json_build_object('status', 401, 'headers', json_build_object())::text;
  end if;
  -- The status of the agent is not read here: a disabled agent stays the principal, so current_agent_id() is null
  -- and every agent RPC refuses it. Falling back to the person would widen the chat's reach.
  select * into v_a from public.agents where id = v_l.agent_id;
  perform set_config('request.jwt.claims', (v_claims || jsonb_build_object(
    'sub', v_a.auth_user_id, 'via_user', v_user,
    'app_metadata', jsonb_build_object('principal_type', 'agent', 'agent_id', v_a.id, 'workspace_id', v_a.workspace_id)))::text, true);
  perform set_config('request.jwt.claim.sub', v_a.auth_user_id::text, true);
end $$;
revoke execute on function private.apply_session_link() from public;
grant execute on function private.apply_session_link() to anon, authenticated, service_role;

-- Who the caller is after the hook. The mcp function reads it once per request for an OAuth token.
create or replace function public.session_identity()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_link public.agent_oauth_links%rowtype;
begin
  -- Check every link, including disabled/revoked ones. linked_agent_id intentionally filters those out.
  if private.principal_type() = 'human' and private.jwt_client_id() is not null then
    select * into v_link from public.agent_oauth_links
     where user_id = (select auth.uid()) and client_id = private.jwt_client_id();
    if found then
      if v_link.revoked_at is not null then
        raise sqlstate 'PGRST' using
          message = json_build_object('code', 'link_revoked', 'message', 'link_revoked', 'details', null, 'hint', null)::text,
          detail = json_build_object('status', 401, 'headers', json_build_object())::text;
      end if;
      raise exception using errcode = 'PT500', message = 'session_link_not_applied';
    end if;
  end if;
  return jsonb_build_object('principal_type', private.principal_type(), 'user_id', (select auth.uid()),
    'agent_id', auth.jwt() -> 'app_metadata' ->> 'agent_id', 'workspace_id', auth.jwt() -> 'app_metadata' ->> 'workspace_id',
    'via_user', auth.jwt() ->> 'via_user');
end $$;
revoke all on function public.session_identity() from public, anon;
grant execute on function public.session_identity() to authenticated;

-- Agents the caller may connect a chat as. Taking on an agent's grants is a decision of its sponsor or the owner.
create or replace function public.linkable_agents()
returns table (id uuid, name text, workspace_id uuid, role text) language sql stable security definer set search_path = '' as $$
  select a.id, a.name, a.workspace_id, a.role from public.agents a
   where private.principal_type() = 'human' and private.jwt_client_id() is null
     and a.status = 'enabled' and a.revoked_at is null and not a.is_platform
     and (a.sponsor_user_id = (select auth.uid()) or private.is_workspace_owner(a.workspace_id))
   order by a.name;
$$;
revoke all on function public.linkable_agents() from public, anon;
grant execute on function public.linkable_agents() to authenticated;

-- Connects this person's chat client as an agent; a null agent removes the link, so the chat acts as the person.
create or replace function public.set_oauth_link(p_client_id text, p_agent_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_a public.agents%rowtype; v_old public.agent_oauth_links%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if coalesce(btrim(p_client_id), '') = '' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if p_agent_id is null then
    delete from public.agent_oauth_links where user_id = v_uid and client_id = p_client_id returning * into v_old;
    if found then
      perform private.audit(v_old.workspace_id, 'oauth.unlink', jsonb_build_object('client_id', p_client_id, 'agent_id', v_old.agent_id));
    end if;
    return jsonb_build_object('linked', false);
  end if;
  select * into v_a from public.agents where id = p_agent_id;
  if not found or v_a.revoked_at is not null or v_a.status <> 'enabled' or v_a.is_platform then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  if v_a.sponsor_user_id <> v_uid and not private.is_workspace_owner(v_a.workspace_id) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  insert into public.agent_oauth_links (workspace_id, agent_id, user_id, client_id)
  values (v_a.workspace_id, v_a.id, v_uid, p_client_id)
  on conflict (user_id, client_id) do update
    set workspace_id = excluded.workspace_id, agent_id = excluded.agent_id, created_at = now(), revoked_at = null;
  perform private.audit(v_a.workspace_id, 'oauth.link', jsonb_build_object('client_id', p_client_id, 'agent_id', v_a.id));
  return jsonb_build_object('linked', true, 'agent_id', v_a.id, 'agent_name', v_a.name);
end $$;
revoke all on function public.set_oauth_link(text, uuid) from public, anon;
grant execute on function public.set_oauth_link(text, uuid) to authenticated;

-- Disconnects a linked chat now: its tokens are refused by the hook until the person connects it again.
create or replace function public.revoke_oauth_link(p_client_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_l public.agent_oauth_links%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  update public.agent_oauth_links set revoked_at = now()
   where user_id = (select auth.uid()) and client_id = p_client_id and revoked_at is null returning * into v_l;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  perform private.audit(v_l.workspace_id, 'oauth.revoke', jsonb_build_object('client_id', p_client_id, 'agent_id', v_l.agent_id));
  return jsonb_build_object('revoked', true);
end $$;
revoke all on function public.revoke_oauth_link(text) from public, anon;
grant execute on function public.revoke_oauth_link(text) to authenticated;

-- The stamp on a block says the agent wrote it and who connected the chat (via).
create or replace function private.apply_page_ops_core(p_page_id text, p_ops jsonb, p_client text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.pages%rowtype;
  v_data jsonb;
  v_before jsonb;
  v_op jsonb;
  v_actor jsonb;
  v_item jsonb;
  v_patch jsonb;
  v_array jsonb;
  v_path text[];
  v_list_path text[];
  v_predecessors jsonb := '{}';
  v_id text;
  v_after text;
  v_old_after text;
  v_index integer;
  v_rev bigint;
  v_i integer := 0;
  v_walk integer;
  v_result jsonb;
  v_results jsonb := '[]';
  v_inverse jsonb := '[]';
  v_undo jsonb;
  v_revision bigint;
  rec record;
begin
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) > 200 then
    raise exception using errcode = 'PT400', message = 'invalid_operations';
  end if;
  select * into v_row from public.pages where id = p_page_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  v_data := v_row.data;
  v_actor := jsonb_strip_nulls(jsonb_build_object('by', private.principal_type(), 'id', auth.uid(), 'via', auth.jwt() ->> 'via_user', 'runId', private.current_run_id(), 'at', floor(extract(epoch from clock_timestamp()) * 1000)::bigint));
  for rec in select * from private.block_paths(v_data) loop
    v_index := rec.path[array_length(rec.path, 1)]::integer;
    v_list_path := rec.path[1:array_length(rec.path, 1)-1];
    v_predecessors := v_predecessors || jsonb_build_object(rec.block->>'id', case when v_index > 0 then v_data #>> (v_list_path || array[(v_index - 1)::text, 'id']) else null end);
  end loop;
  for v_op in select value from jsonb_array_elements(p_ops) loop
    if jsonb_typeof(v_op) <> 'object' or not (v_op ? 'op') then raise exception using errcode = 'PT400', message = 'invalid_operation'; end if;
    if v_data is null and v_op->>'op' <> 'replace_page' then raise exception using errcode = 'PT404', message = 'page_deleted'; end if;
    v_before := v_data;
    v_result := jsonb_build_object('i', v_i, 'ok', true);
    v_undo := null;
    v_item := null;
    v_path := null;
    v_id := coalesce(v_op->>'id', v_op->>'rowId');
    if v_op->>'op' in ('update_block', 'delete_block', 'move_block') then
      v_path := private.block_path(v_data, v_id);
      if v_path is not null then v_item := v_data #> v_path; end if;
    elsif v_op->>'op' in ('db_cell_set', 'db_row_delete', 'db_row_move') then
      v_index := private.array_id_index(v_data->'database'->'rows', v_id);
      if v_index is not null then v_path := array['database','rows',v_index::text]; v_item := v_data #> v_path; end if;
    end if;
    if v_item is not null and v_op->>'op' in ('update_block','delete_block','db_cell_set','db_row_delete')
       and v_op ? 'rev' and (v_op->>'rev')::bigint < coalesce((v_item->>'rev')::bigint, 0) then
      if private.is_agent() then
        raise exception using errcode = 'PT409', message = 'block_conflict', detail = jsonb_build_object('page_id', p_page_id, 'block_id', v_id, 'rev', v_item->'rev', 'text', left(coalesce(v_item->>'html', v_item::text), 2000))::text;
      end if;
      v_result := v_result || jsonb_build_object('conflict', jsonb_strip_nulls(jsonb_build_object('id', v_id, 'theirs', case when v_op->>'op' = 'db_cell_set' then coalesce(v_item->'cells'->(v_op->>'propertyId'), 'null') else v_item end, 'by', v_item->'attr')));
    end if;
    case v_op->>'op'
      when 'insert_block' then
        v_item := v_op->'block';
        if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'id','') = '' or private.block_path(v_data, v_item->>'id') is not null then raise exception using errcode = 'PT400', message = 'invalid_block'; end if;
        v_after := v_op->>'after'; v_walk := 0;
        while v_after is not null and private.block_path(v_data, v_after) is null loop
          v_after := v_predecessors->>v_after; v_walk := v_walk + 1;
          if v_walk > 10000 then v_after := null; end if;
        end loop;
        v_path := private.block_path(v_data, v_after);
        v_list_path := case when v_path is null then array['blocks'] else v_path[1:array_length(v_path,1)-1] end;
        v_rev := coalesce((v_item->>'rev')::bigint, 0) + 1;
        v_item := v_item || jsonb_build_object('rev', v_rev, 'attr', v_actor);
        v_data := jsonb_set(v_data, v_list_path, private.array_insert_after(v_data #> v_list_path, v_item, v_after), true);
        v_predecessors := v_predecessors || jsonb_build_object(v_item->>'id', v_after);
        v_result := v_result || jsonb_build_object('rev', v_rev);
        v_undo := jsonb_build_object('op','delete_block','id',v_item->>'id');
      when 'update_block' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_patch := coalesce(v_op->'patch','{}') - 'id' - 'rev' - 'attr';
          if jsonb_typeof(v_patch) <> 'object' then raise exception using errcode = 'PT400', message = 'invalid_block_patch'; end if;
          select coalesce(jsonb_object_agg(key, v_item->key), '{}') into v_array from jsonb_object_keys(v_patch) key;
          v_undo := jsonb_build_object('op','update_block','id',v_id,'patch',v_array);
          v_rev := coalesce((v_item->>'rev')::bigint, 0) + 1;
          v_data := jsonb_set(v_data, v_path, v_item || v_patch || jsonb_build_object('rev',v_rev,'attr',v_actor));
          v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'delete_block' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[array_length(v_path,1)]::integer;
          v_list_path := v_path[1:array_length(v_path,1)-1];
          v_old_after := case when v_index > 0 then v_data #>> (v_list_path || array[(v_index-1)::text,'id']) else null end;
          v_undo := jsonb_build_object('op','insert_block','after',v_old_after,'block',v_item);
          v_data := v_data #- v_path;
          v_result := v_result || jsonb_build_object('rev',coalesce((v_item->>'rev')::bigint,0)+1);
        end if;
      when 'move_block' then
        if v_item is null or v_op->>'after' = v_id then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[array_length(v_path,1)]::integer;
          v_list_path := v_path[1:array_length(v_path,1)-1];
          v_old_after := case when v_index > 0 then v_data #>> (v_list_path || array[(v_index-1)::text,'id']) else null end;
          v_undo := jsonb_build_object('op','move_block','id',v_id,'after',v_old_after);
          v_data := v_data #- v_path;
          v_after := v_op->>'after'; v_walk := 0;
          while v_after is not null and private.block_path(v_data,v_after) is null loop
            v_after := v_predecessors->>v_after; v_walk := v_walk + 1; if v_walk > 10000 then v_after := null; end if;
          end loop;
          v_path := private.block_path(v_data,v_after);
          v_list_path := case when v_path is null then array['blocks'] else v_path[1:array_length(v_path,1)-1] end;
          v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
          v_data := jsonb_set(v_data,v_list_path,private.array_insert_after(v_data #> v_list_path,v_item || jsonb_build_object('rev',v_rev,'attr',v_actor),v_after));
          v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'set_page' then
        select coalesce(jsonb_object_agg(key,value),'{}') into v_patch from jsonb_each(coalesce(v_op->'patch','{}'))
        where key = any(array['title','icon','cover','coverPosition','fullWidth','smallText','locked','font','isFavorite']);
        select coalesce(jsonb_object_agg(key,v_data->key),'{}') into v_array from jsonb_object_keys(v_patch) key;
        v_undo := jsonb_build_object('op','set_page','patch',v_array);
        v_data := v_data || v_patch;
      when 'db_row_add' then
        if v_data->'database' is null then raise exception using errcode = 'PT400', message = 'not_a_database'; end if;
        v_item := v_op->'row';
        if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'id','') = '' then raise exception using errcode = 'PT400', message = 'invalid_row'; end if;
        v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
        v_item := v_item || jsonb_build_object('rev',v_rev,'createdBy',coalesce(v_item->>'createdBy',auth.uid()::text),'lastEditedBy',auth.uid());
        v_data := jsonb_set(v_data,'{database,rows}',private.array_insert_after(v_data->'database'->'rows',v_item,v_op->>'after'));
        v_result := v_result || jsonb_build_object('rev',v_rev);
        v_undo := jsonb_build_object('op','db_row_delete','rowId',v_item->>'id');
      when 'db_cell_set' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_undo := jsonb_build_object('op','db_cell_set','rowId',v_id,'propertyId',v_op->>'propertyId','value',coalesce(v_item->'cells'->(v_op->>'propertyId'),'null'));
          v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
          v_item := v_item || jsonb_build_object('cells',coalesce(v_item->'cells','{}') || jsonb_build_object(v_op->>'propertyId',coalesce(v_op->'value','null')),'rev',v_rev,'lastEditedBy',auth.uid());
          v_data := jsonb_set(v_data,v_path,v_item); v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'db_row_delete' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[3]::integer;
          v_undo := jsonb_build_object('op','db_row_add','row',v_item,'after',case when v_index > 0 then v_data #>> array['database','rows',(v_index-1)::text,'id'] else null end);
          select coalesce(jsonb_agg(case when value->>'parentRowId' = v_id then value - 'parentRowId' else value end order by ordinality),'[]') into v_array
          from jsonb_array_elements(v_data->'database'->'rows') with ordinality where value->>'id' <> v_id;
          v_data := jsonb_set(v_data,'{database,rows}',v_array); v_result := v_result || jsonb_build_object('rev',coalesce((v_item->>'rev')::bigint,0)+1);
        end if;
      when 'db_row_move' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[3]::integer;
          v_undo := jsonb_build_object('op','db_row_move','rowId',v_id,'after',case when v_index > 0 then v_data #>> array['database','rows',(v_index-1)::text,'id'] else null end,'parentRowId',v_item->'parentRowId');
          v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
          v_item := v_item || jsonb_build_object('rev',v_rev,'lastEditedBy',auth.uid());
          if v_op ? 'parentRowId' then v_item := v_item || jsonb_build_object('parentRowId',v_op->'parentRowId'); end if;
          v_data := jsonb_set(v_data,'{database,rows}',private.array_insert_after(v_data->'database'->'rows',v_item,v_op->>'after'));
          v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'db_prop_set' then
        v_item := v_op->'property'; v_index := private.array_id_index(v_data->'database'->'properties',v_item->>'id');
        if v_index is null then v_undo := jsonb_build_object('op','db_prop_delete','propertyId',v_item->>'id');
        else v_undo := jsonb_build_object('op','db_prop_set','property',v_data->'database'->'properties'->v_index,'after',case when v_index > 0 then v_data #>> array['database','properties',(v_index-1)::text,'id'] else null end); end if;
        if v_op ? 'after' or v_index is null then
          v_after := case when v_op ? 'after' then v_op->>'after' else v_data->'database'->'properties'->-1->>'id' end;
          v_data := jsonb_set(v_data,'{database,properties}',private.array_insert_after(v_data->'database'->'properties',v_item,v_after));
        else v_data := jsonb_set(v_data,array['database','properties',v_index::text],v_item); end if;
      when 'db_prop_delete' then
        v_id := v_op->>'propertyId'; v_index := private.array_id_index(v_data->'database'->'properties',v_id);
        if v_index is not null then
          v_undo := jsonb_build_object('op','replace_page','page',v_before,'revision',v_row.revision);
          v_data := v_data #- array['database','properties',v_index::text];
          select coalesce(jsonb_agg(jsonb_set(value,'{cells}',coalesce(value->'cells','{}') - v_id) order by ordinality),'[]') into v_array from jsonb_array_elements(v_data->'database'->'rows') with ordinality;
          v_data := jsonb_set(v_data,'{database,rows}',v_array);
        end if;
      when 'db_view_set' then
        v_item := v_op->'view'; v_index := private.array_id_index(v_data->'database'->'views',v_item->>'id');
        if v_index is null then v_data := jsonb_set(v_data,'{database,views}',coalesce(v_data->'database'->'views','[]') || jsonb_build_array(v_item)); v_undo := jsonb_build_object('op','db_view_delete','viewId',v_item->>'id');
        else v_undo := jsonb_build_object('op','db_view_set','view',v_data #> array['database','views',v_index::text]); v_data := jsonb_set(v_data,array['database','views',v_index::text],v_item); end if;
      when 'db_view_delete' then
        v_index := private.array_id_index(v_data->'database'->'views',v_op->>'viewId');
        if v_index is not null then v_undo := jsonb_build_object('op','db_view_set','view',v_data #> array['database','views',v_index::text]); v_data := v_data #- array['database','views',v_index::text]; end if;
      when 'comment_add' then
        v_item := v_op->'comment';
        if coalesce(btrim(v_item->>'body'),'') = '' then raise exception using errcode = 'PT400', message = 'empty_comment'; end if;
        v_item := v_item || jsonb_build_object('authorId',auth.uid(),'authorType',private.principal_type());
        select coalesce(jsonb_agg(value order by ordinality),'[]') into v_array from jsonb_array_elements(coalesce(v_data->'comments','[]')) with ordinality where value->>'id' <> v_item->>'id';
        v_data := jsonb_set(v_data,'{comments}',v_array || jsonb_build_array(v_item),true);
        v_index := private.array_id_index(v_before->'comments',v_item->>'id');
        if v_index is null then
          v_undo := jsonb_build_object('op','comment_delete','id',v_item->>'id');
          perform private.notify_comment(p_page_id,v_row.workspace_id,v_before,v_item);
        else v_undo := jsonb_build_object('op','comment_add','comment',v_before->'comments'->v_index); end if;
      when 'comment_set' then
        v_index := private.array_id_index(v_data->'comments',v_id);
        if v_index is not null then
          v_item := v_data->'comments'->v_index;
          if (v_op->'patch') ? 'body' and v_item->>'authorId' is distinct from auth.uid()::text then raise exception using errcode = 'PT403', message = 'comment_author_only'; end if;
          v_patch := coalesce(v_op->'patch','{}') - 'id' - 'authorId' - 'authorType' - 'runId';
          v_data := jsonb_set(v_data,array['comments',v_index::text],v_item || v_patch);
        end if;
      when 'comment_delete' then
        v_index := private.array_id_index(v_data->'comments',v_id);
        if v_index is not null then
          v_item := v_data->'comments'->v_index;
          if private.is_agent() and v_item->>'authorId' is distinct from auth.uid()::text then raise exception using errcode = 'PT403', message = 'comment_author_only'; end if;
          v_undo := jsonb_build_object('op','comment_add','comment',v_item);
          v_data := v_data #- array['comments',v_index::text];
        end if;
      when 'version_delete' then
        if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
        v_index := private.array_id_index(v_data->'versions',v_id);
        if v_index is not null then
          v_undo := jsonb_build_object('op','version_add','version',v_data->'versions'->v_index);
          v_data := v_data #- array['versions',v_index::text];
        end if;
      when 'version_add' then
        select coalesce(jsonb_agg(value order by ordinality),'[]') into v_array from (
          select value, ordinality from jsonb_array_elements(coalesce(v_data->'versions','[]')) with ordinality where value->>'id' <> v_op->'version'->>'id' order by ordinality limit 9
        ) versions;
        v_data := jsonb_set(v_data,'{versions}',jsonb_build_array(v_op->'version') || v_array,true);
      when 'replace_page' then
        if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
        if jsonb_typeof(v_op->'page') is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_page'; end if;
        if coalesce(v_op->>'revision','') !~ '^[0-9]+$' then raise exception using errcode = 'PT400', message = 'invalid_revision'; end if;
        if v_row.data is not null and (v_op->>'revision')::bigint <> v_row.revision then
          raise exception using errcode = 'PT409', message = 'page_conflict', detail = jsonb_build_object('page_id', p_page_id, 'revision', v_row.revision)::text;
        end if;
        v_data := (v_op->'page') || jsonb_build_object('id',p_page_id);
      else raise exception using errcode = 'PT400', message = 'unknown_operation';
    end case;
    if v_data is distinct from v_before then
      if v_undo is null then v_undo := jsonb_build_object('op','replace_page','page',v_before,'revision',v_row.revision); end if;
      v_inverse := jsonb_build_array(v_undo) || v_inverse;
    end if;
    v_results := v_results || jsonb_build_array(v_result); v_i := v_i + 1;
  end loop;
  perform set_config('app.ops_write','1',true);
  update public.pages set data = v_data || jsonb_build_object('_client',p_client),
    deleted_at = case when coalesce((v_data->>'isDeleted')::boolean,false) then coalesce(deleted_at,now()) else null end,
    parent_id = case when v_data ? 'parentId' then v_data->>'parentId' else parent_id end
    where id = p_page_id returning revision into v_revision;
  perform set_config('app.ops_write','',true);
  return jsonb_build_object('revision',v_revision,'results',v_results,'inverse',v_inverse);
end;
$$;
revoke all on function private.apply_page_ops_core(text,jsonb,text) from public, anon, authenticated;


-- Last, once the function exists: registered earlier, every Data API request would fail in between.
alter role authenticator set pgrst.db_pre_request = 'private.apply_session_link';
notify pgrst, 'reload config';
