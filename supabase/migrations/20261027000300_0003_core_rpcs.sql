create or replace function private.block_paths(p_data jsonb)
returns table(block jsonb, path text[]) language sql immutable set search_path = '' as $$
  with recursive nodes(block, path) as (
    select b.value, array['blocks', (b.ordinality - 1)::text]
    from jsonb_array_elements(coalesce(p_data->'blocks', '[]')) with ordinality b
    union all
    select b.value, n.path || array['columns', (c.ordinality - 1)::text, 'blocks', (b.ordinality - 1)::text]
    from nodes n
      cross join lateral jsonb_array_elements(coalesce(n.block->'columns', '[]')) with ordinality c
      cross join lateral jsonb_array_elements(coalesce(c.value->'blocks', '[]')) with ordinality b
  ) select * from nodes;
$$;
create or replace function private.block_path(p_data jsonb, p_id text)
returns text[] language sql immutable set search_path = '' as $$
  select path from private.block_paths(p_data) where block->>'id' = p_id limit 1;
$$;
create or replace function private.array_id_index(p_array jsonb, p_id text)
returns integer language sql immutable set search_path = '' as $$
  select (ordinality - 1)::integer from jsonb_array_elements(coalesce(p_array, '[]')) with ordinality where value->>'id' = p_id limit 1;
$$;
create or replace function private.array_insert_after(p_array jsonb, p_item jsonb, p_after text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_array jsonb; v_index integer;
begin
  select coalesce(jsonb_agg(value order by ordinality), '[]') into v_array
  from jsonb_array_elements(coalesce(p_array, '[]')) with ordinality where value->>'id' is distinct from p_item->>'id';
  v_index := coalesce(private.array_id_index(v_array, p_after) + 1, 0);
  return jsonb_insert(v_array, array[v_index::text], p_item, false);
end;
$$;

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
  v_actor := jsonb_strip_nulls(jsonb_build_object('by', private.principal_type(), 'id', auth.uid(), 'runId', private.current_run_id(), 'at', floor(extract(epoch from clock_timestamp()) * 1000)::bigint));
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
        if private.array_id_index(v_before->'comments',v_item->>'id') is null then
          perform private.notify_comment(p_page_id,v_row.workspace_id,v_before,v_item);
        end if;
      when 'comment_set' then
        v_index := private.array_id_index(v_data->'comments',v_id);
        if v_index is not null then
          v_item := v_data->'comments'->v_index;
          if (v_op->'patch') ? 'body' and v_item->>'authorId' is distinct from auth.uid()::text then raise exception using errcode = 'PT403', message = 'comment_author_only'; end if;
          v_patch := coalesce(v_op->'patch','{}') - 'id' - 'authorId' - 'authorType' - 'runId';
          v_data := jsonb_set(v_data,array['comments',v_index::text],v_item || v_patch);
        end if;
      when 'version_add' then
        select coalesce(jsonb_agg(value order by ordinality),'[]') into v_array from (
          select value, ordinality from jsonb_array_elements(coalesce(v_data->'versions','[]')) with ordinality where value->>'id' <> v_op->'version'->>'id' order by ordinality limit 49
        ) versions;
        v_data := jsonb_set(v_data,'{versions}',jsonb_build_array(v_op->'version') || v_array,true);
      when 'replace_page' then
        if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
        if jsonb_typeof(v_op->'page') is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_page'; end if;
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
revoke all on all functions in schema private from public;

create or replace function public.apply_page_ops(p_page_id text, p_ops jsonb, p_client text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_result jsonb; v_scope text := 'page:' || p_page_id;
begin
  select workspace_id into v_ws from public.pages where id = p_page_id;
  if v_ws is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not coalesce(private.can_write_page(p_page_id,v_ws),false) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_scope || ':' || p_idempotency_key || ':' || auth.uid()::text,0));
    select result into v_result from private.write_receipts where scope = v_scope and key = p_idempotency_key and actor_id = auth.uid();
    if found then return v_result; end if;
  end if;
  v_result := private.apply_page_ops_core(p_page_id,p_ops,p_client) - 'inverse';
  if p_idempotency_key is not null then insert into private.write_receipts(scope,key,actor_id,result) values(v_scope,p_idempotency_key,auth.uid(),v_result); end if;
  return v_result;
end;
$$;
revoke all on function public.apply_page_ops(text,jsonb,text,text) from public,anon;
grant execute on function public.apply_page_ops(text,jsonb,text,text) to authenticated;

create or replace function public.apply_workspace_ops(p_workspace_id uuid, p_ops jsonb, p_client text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ws public.workspaces%rowtype; v_op jsonb; v_revision bigint;
begin
  if not private.is_human_editor(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) > 200 then raise exception using errcode = 'PT400', message = 'invalid_operations'; end if;
  select * into v_ws from public.workspaces where id = p_workspace_id for update;
  for v_op in select value from jsonb_array_elements(p_ops) loop
    case v_op->>'op'
      when 'set_root_order' then v_ws.root_order := v_op->'rootOrder';
      when 'set_settings' then v_ws.settings := v_ws.settings || v_op->'patch';
      when 'synced_set' then
        if v_op->'blocks' = 'null'::jsonb then v_ws.synced_blocks := v_ws.synced_blocks - (v_op->>'key');
        else v_ws.synced_blocks := v_ws.synced_blocks || jsonb_build_object(v_op->>'key',v_op->'blocks'); end if;
      else raise exception using errcode = 'PT400', message = 'unknown_operation';
    end case;
  end loop;
  perform set_config('app.ops_write','1',true);
  update public.workspaces set root_order = v_ws.root_order, synced_blocks = v_ws.synced_blocks, settings = v_ws.settings where id = p_workspace_id returning revision into v_revision;
  perform set_config('app.ops_write','',true);
  return jsonb_build_object('revision',v_revision,'client',p_client);
end;
$$;
revoke all on function public.apply_workspace_ops(uuid,jsonb,text) from public,anon;
grant execute on function public.apply_workspace_ops(uuid,jsonb,text) to authenticated;

-- email -> user id. Solo la llama share_page (sin grants).
create or replace function private.user_id_by_email(p_email text)
returns uuid language sql security definer set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
$$;
revoke all on function private.user_id_by_email(text) from public, anon, authenticated;

create or replace function public.share_page(p_page_id text, p_email text, p_level text)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid;
  v_user uuid;
begin
  if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if p_level not in ('view', 'comment', 'edit') then
    return 'Invalid access level.';
  end if;
  select workspace_id into v_ws from public.pages where id = p_page_id;
  if v_ws is null then
    return 'This page is not synced yet.';
  end if;
  if not private.can_edit_workspace(v_ws) then
    return 'You do not have permission to share this page.';
  end if;
  v_user := private.user_id_by_email(p_email);
  if v_user is null then
    return 'No user with that email exists.';
  end if;
  if v_user = (select auth.uid()) then
    return 'You cannot share a page with yourself.';
  end if;
  insert into public.page_shares (page_id, user_id, level)
  values (p_page_id, v_user, p_level)
  on conflict (page_id, user_id) do update set level = excluded.level;
  if to_regclass('public.notifications') is not null then
    insert into public.notifications(workspace_id,user_id,kind,page_id,actor_id,actor_type,payload) values(v_ws,v_user,'share',p_page_id,auth.uid(),'human',jsonb_build_object('level',p_level));
  end if;
  return 'ok';
end;
$$;
revoke all on function public.share_page(text, text, text) from public, anon;
grant execute on function public.share_page(text, text, text) to authenticated;

create or replace function public.list_page_shares(p_page_id text)
returns table(user_id uuid, email text, level text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select workspace_id into v_ws from public.pages where id = p_page_id;
  if v_ws is null or not private.can_edit_workspace(v_ws) then
    return;
  end if;
  return query
    select s.user_id, u.email::text, s.level
    from public.page_shares s
    join auth.users u on u.id = s.user_id
    where s.page_id = p_page_id
    order by u.email;
end;
$$;
revoke all on function public.list_page_shares(text) from public, anon;
grant execute on function public.list_page_shares(text) to authenticated;

create or replace function private.all_blocks(p_data jsonb)
returns setof jsonb language sql immutable set search_path to ''
as $$
  with top as (
    select b
    from jsonb_array_elements(
      case when jsonb_typeof(p_data->'blocks') = 'array'
           then p_data->'blocks' else '[]'::jsonb end
    ) b
  )
  select b from top
  union all
  select cb
  from top,
       lateral jsonb_array_elements(
         case when jsonb_typeof(top.b->'columns') = 'array'
              then top.b->'columns' else '[]'::jsonb end
       ) c,
       lateral jsonb_array_elements(
         case when jsonb_typeof(c->'blocks') = 'array'
              then c->'blocks' else '[]'::jsonb end
       ) cb;
$$;

-- Páginas referenciadas por una página.
--   'full' -> hace falta su contenido (filas de base de datos, bases inline/enlazadas, bases destino de relación)
--   'link' -> solo título/icono (bloques de enlace a subpágina)
create or replace function private.page_refs(p_data jsonb)
returns table (page_id text, kind text)
language sql immutable set search_path to ''
as $$
  select r->>'pageId', 'full'
  from jsonb_array_elements(
    case when jsonb_typeof(p_data->'database'->'rows') = 'array'
         then p_data->'database'->'rows' else '[]'::jsonb end
  ) r
  where r->>'pageId' is not null
  union all
  select p->>'relationDbId', 'full'
  from jsonb_array_elements(
    case when jsonb_typeof(p_data->'database'->'properties') = 'array'
         then p_data->'database'->'properties' else '[]'::jsonb end
  ) p
  where p->>'type' = 'relation' and p->>'relationDbId' is not null
  union all
  select b->>'pageId',
         case when b->>'type' = 'database' then 'full' else 'link' end
  from private.all_blocks(p_data) b
  where b->>'type' in ('database', 'page') and b->>'pageId' is not null;
$$;

-- Página NO raíz: sin comentarios, sin versiones, sin etiqueta de cliente.
create or replace function private.strip_page(p_data jsonb)
returns jsonb language sql immutable set search_path to ''
as $$
  select (p_data - 'versions' - 'comments' - '_client');
$$;

-- Stub título/icono de una subpágina enlazada (su cuerpo NO se revela).
create or replace function private.page_stub(p_id text, p_data jsonb)
returns jsonb language sql immutable set search_path to ''
as $$
  select jsonb_build_object(
    'id', p_id,
    'title', coalesce(p_data->>'title', ''),
    'icon', coalesce(p_data->'icon', 'null'::jsonb),
    'cover', 'null'::jsonb,
    'parentId', coalesce(p_data->'parentId', 'null'::jsonb),
    'blocks', '[]'::jsonb,
    'isFavorite', false,
    'isDeleted', false,
    'fullWidth', false,
    'smallText', false,
    'createdAt', coalesce(p_data->'createdAt', '0'::jsonb),
    'updatedAt', coalesce(p_data->'updatedAt', '0'::jsonb),
    'stub', true
  );
$$;

create or replace function public.get_page_bundle(p_page_id text, p_max_pages int default 200)
returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare
  v_max_depth constant int := 3;
  v_max_pages int := greatest(1, least(coalesce(p_max_pages, 200), 200));
  v_root       public.pages%rowtype;
  v_ws         uuid;
  v_full       jsonb := '{}'::jsonb;   -- id -> página completa (raíz incluida)
  v_links      jsonb := '{}'::jsonb;   -- id -> stub título/icono
  v_synced     jsonb := '{}'::jsonb;
  v_frontier   text[];
  v_next_full  text[];
  v_next_link  text[];
  v_keys       text[];
  v_truncated  boolean := false;
  v_count      int;
  d            int;
  rec          record;
begin
  select * into v_root
  from public.pages
  where id = p_page_id and deleted_at is null;

  if not found
     or v_root.data is null
     or coalesce((v_root.data->>'isDeleted')::boolean, false) then
    return null;
  end if;

  v_ws := v_root.workspace_id;

  -- ÚNICA comprobación de acceso: todo lo demás deriva de esta página
  if not (
    coalesce(v_root.published, false)
    or private.can_read_page(p_page_id, v_ws)
  ) then
    return null;
  end if;

  v_full := jsonb_build_object(p_page_id, private.strip_page(v_root.data));
  v_frontier := array[p_page_id];

  for d in 1..v_max_depth loop
    exit when coalesce(array_length(v_frontier, 1), 0) = 0;

    select coalesce(array_agg(distinct r.page_id) filter (where r.kind = 'full'), '{}'),
           coalesce(array_agg(distinct r.page_id) filter (where r.kind = 'link'), '{}')
      into v_next_full, v_next_link
    from unnest(v_frontier) fid,
         lateral private.page_refs(v_full -> fid) r;

    select coalesce(array_agg(x), '{}') into v_next_full
    from unnest(v_next_full) x
    where not (v_full ? x);

    v_frontier := '{}';

    if coalesce(array_length(v_next_full, 1), 0) > 0 then
      for rec in
        select p.id, p.data
        from public.pages p
        where p.id = any (v_next_full)
          and p.workspace_id = v_ws            -- nunca salir del workspace raíz
          and p.deleted_at is null
          and p.data is not null
          and coalesce((p.data->>'isDeleted')::boolean, false) = false
        order by p.id
      loop
        select count(*) into v_count
        from jsonb_object_keys(v_full || v_links);
        if v_count >= v_max_pages then
          v_truncated := true;
          exit;
        end if;
        v_full := v_full || jsonb_build_object(rec.id, private.strip_page(rec.data));
        v_links := v_links - rec.id;         -- un stub se promociona a contenido completo
        v_frontier := v_frontier || rec.id;
      end loop;
    end if;

    -- enlaces a subpáginas: solo título/icono, nunca se recorren
    select coalesce(array_agg(x), '{}') into v_next_link
    from unnest(v_next_link) x
    where not (v_full ? x) and not (v_links ? x);

    if coalesce(array_length(v_next_link, 1), 0) > 0 and not v_truncated then
      for rec in
        select p.id, p.data
        from public.pages p
        where p.id = any (v_next_link)
          and p.workspace_id = v_ws
          and p.deleted_at is null
          and p.data is not null
          and coalesce((p.data->>'isDeleted')::boolean, false) = false
        order by p.id
      loop
        select count(*) into v_count
        from jsonb_object_keys(v_full || v_links);
        if v_count >= v_max_pages then
          v_truncated := true;
          exit;
        end if;
        v_links := v_links || jsonb_build_object(rec.id, private.page_stub(rec.id, rec.data));
      end loop;
    end if;

    exit when v_truncated;
  end loop;

  -- contenido de bloques sincronizados referenciado por cualquier página incluida
  select coalesce(array_agg(distinct coalesce(b->>'syncedFrom', b->>'id')), '{}')
    into v_keys
  from jsonb_each(v_full) e,
       lateral private.all_blocks(e.value) b
  where b->>'type' = 'synced';

  if coalesce(array_length(v_keys, 1), 0) > 0 then
    select coalesce(jsonb_object_agg(k, w.synced_blocks -> k), '{}'::jsonb)
      into v_synced
    from public.workspaces w,
         unnest(v_keys) k
    where w.id = v_ws
      and jsonb_typeof(w.synced_blocks) = 'object'
      and w.synced_blocks ? k;
  end if;

  return jsonb_build_object(
    'page', (v_root.data - 'versions' - '_client'),   -- la raíz conserva sus comentarios
    'updatedAt', (extract(epoch from v_root.updated_at) * 1000)::bigint,
    'pages', (v_full - p_page_id) || v_links,
    'syncedBlocks', coalesce(v_synced, '{}'::jsonb),
    'truncated', v_truncated
  );
end;
$$;
revoke all on function public.get_page_bundle(text, int) from public;
grant execute on function public.get_page_bundle(text, int) to anon, authenticated;

-- ============ Web Push: secretos ============

create or replace function public.push_config()
returns table (vapid_public text, vapid_private text, cron_secret text, vapid_subject text)
language sql security definer set search_path = ''
as $$
  select
    max(value) filter (where name = 'vapid_public')  as vapid_public,
    max(value) filter (where name = 'vapid_private') as vapid_private,
    max(value) filter (where name = 'cron_secret')   as cron_secret,
    max(value) filter (where name = 'vapid_subject') as vapid_subject
  from private.app_secrets;
$$;
revoke all on function public.push_config() from public, anon, authenticated;
grant execute on function public.push_config() to service_role;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('mention','comment_reply','share','invite','input_required','ready_for_review','task_failed','approval_requested','approval_expired','escalation')),
  page_id text, block_id text, comment_id text, task_id uuid, approval_id uuid,
  actor_id uuid, actor_type text check (actor_type in ('human','agent','system')),
  payload jsonb not null default '{}', read_at timestamptz, pushed_at timestamptz,
  emailed_at timestamptz, created_at timestamptz not null default now()
);
create index notifications_unread_idx on public.notifications(user_id,created_at desc) where read_at is null;
alter table public.notifications enable row level security;
revoke all on public.notifications from anon,authenticated;
grant select,update,delete on public.notifications to authenticated;
grant all on public.notifications to service_role;
create policy notifications_select on public.notifications for select to authenticated using (user_id = (select auth.uid()) and (select private.principal_type()) = 'human');
create policy notifications_update on public.notifications for update to authenticated using (user_id = (select auth.uid()) and (select private.principal_type()) = 'human') with check (user_id = (select auth.uid()) and (select private.principal_type()) = 'human');
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = (select auth.uid()) and (select private.principal_type()) = 'human');
alter publication supabase_realtime add table public.notifications;

create or replace function public.mark_notifications_read(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.principal_type() <> 'human' or auth.uid() is null then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  update public.notifications set read_at = coalesce(read_at,now()) where id = any(p_ids) and user_id = auth.uid();
end;
$$;
revoke all on function public.mark_notifications_read(uuid[]) from public,anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

create or replace function private.notify_comment(p_page_id text, p_ws uuid, p_page jsonb, p_comment jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_parent jsonb; v_task record; v_seq bigint; v_body jsonb;
begin
  if to_regclass('public.notifications') is null then return; end if;
  v_parent := p_page->'comments'->private.array_id_index(p_page->'comments',p_comment->>'parentId');
  if v_parent->>'authorType' = 'human' and v_parent->>'authorId' is distinct from auth.uid()::text then
    insert into public.notifications(workspace_id,user_id,kind,page_id,block_id,comment_id,actor_id,actor_type,payload)
    select p_ws,u.id,'comment_reply',p_page_id,p_comment->>'blockId',p_comment->>'id',auth.uid(),private.principal_type(),jsonb_build_object('body',p_comment->>'body')
    from auth.users u where u.id::text = v_parent->>'authorId';
  end if;
  for v_user in select distinct u.id from regexp_matches(p_comment->>'body','data-user="([0-9a-fA-F-]{36})"','g') mention
    join auth.users u on u.id::text = mention[1]
    where u.id <> auth.uid() and (exists(select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id = u.id) or exists(select 1 from public.workspaces w where w.id = p_ws and w.owner_id = u.id))
  loop
    if coalesce((select raw_app_meta_data->>'principal_type' from auth.users where id = v_user),'human') <> 'agent' then
      insert into public.notifications(workspace_id,user_id,kind,page_id,block_id,comment_id,actor_id,actor_type,payload)
      values(p_ws,v_user,'mention',p_page_id,p_comment->>'blockId',p_comment->>'id',auth.uid(),private.principal_type(),jsonb_build_object('body',p_comment->>'body'));
    elsif to_regclass('public.agent_activities') is not null then
      for v_task in execute 'select t.id,t.active_run_id,t.delegate_agent_id from public.agent_tasks t join public.agents a on a.id=t.delegate_agent_id where t.row_page_id=$1 and a.auth_user_id=$2 and t.state not in (''done'',''failed'',''cancelled'') for update of t' using p_page_id,v_user loop
        execute 'update public.agent_tasks set next_seq=next_seq+1 where id=$1 returning next_seq' into v_seq using v_task.id;
        v_body := jsonb_build_object('text',p_comment->>'body','signal','feedback','source','comment','comment_id',p_comment->>'id');
        execute 'insert into public.agent_activities(workspace_id,task_id,run_id,seq,type,body,author_type,author_id) values($1,$2,$3,$4,''prompt'',$5,$6,$7)' using p_ws,v_task.id,v_task.active_run_id,v_seq,v_body,private.principal_type(),auth.uid();
        if to_regclass('public.agent_events') is not null then
          execute 'insert into public.agent_events(workspace_id,task_id,run_id,agent_id,type,payload,seq,lease_until) values($1,$2,$3,$4,''task.feedback'',$5,$6,now()+interval ''30 seconds'')' using p_ws,v_task.id,v_task.active_run_id,v_task.delegate_agent_id,v_body,v_seq;
        end if;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function private.notify_comment(text,uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.add_page_comment(p_page_id text, p_body text, p_block_id text default null, p_anchor_id text default null, p_parent_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_level text; v_allowed boolean; v_comment jsonb; v_name text;
begin
  if coalesce(btrim(p_body),'') = '' then return 'Comment cannot be empty.'; end if;
  if length(p_body) > 10000 then return 'Comment is too long.'; end if;
  select workspace_id into v_ws from public.pages where id = p_page_id;
  if v_ws is null then return 'Page not found.'; end if;
  select level into v_level from public.page_shares where page_id = p_page_id and user_id = auth.uid();
  if private.is_agent() then
    v_allowed := false;
    if to_regprocedure('private.agent_can(text,text)') is not null then execute 'select private.agent_can($1,''comment'')' into v_allowed using p_page_id;
    else v_allowed := private.agent_can_write(p_page_id); end if;
  else v_allowed := coalesce(private.can_edit_workspace(v_ws) or v_level in ('comment','edit'),false); end if;
  if not coalesce(v_allowed,false) then return 'You do not have permission to comment on this page.'; end if;
  select coalesce(nullif(raw_user_meta_data->>'full_name',''),email) into v_name from auth.users where id = auth.uid();
  v_comment := jsonb_strip_nulls(jsonb_build_object('id',replace(gen_random_uuid()::text,'-',''),'body',btrim(p_body),'author',v_name,'authorId',auth.uid(),'authorType',private.principal_type(),'createdAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'blockId',p_block_id,'anchorId',coalesce(p_anchor_id,p_block_id),'parentId',p_parent_id));
  perform private.apply_page_ops_core(p_page_id,jsonb_build_array(jsonb_build_object('op','comment_add','comment',v_comment)),null);
  return 'ok';
end;
$$;
revoke all on function public.add_page_comment(text,text,text,text,text) from public,anon;
grant execute on function public.add_page_comment(text,text,text,text,text) to authenticated;

create or replace function public.search_pages(p_query text, p_limit int default 10, p_kind text default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb; v_limit int := greatest(1,least(coalesce(p_limit,10),20));
begin
  if p_kind = 'task' then
    if to_regclass('public.agent_tasks') is null then return '[]'; end if;
    execute 'select coalesce(jsonb_agg(to_jsonb(r)),''[]'') from (select id,title,''/page/''||row_page_id as url,ts_headline(''simple'',title,plainto_tsquery(''simple'',$1)) as snippet,''task'' as kind,updated_at from public.agent_tasks where to_tsvector(''simple'',title) @@ plainto_tsquery(''simple'',$1) order by ts_rank(to_tsvector(''simple'',title),plainto_tsquery(''simple'',$1)) desc limit $2) r' into v_result using p_query,v_limit;
    return v_result;
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)),'[]') into v_result from (
    select id,title,'/page/'||id as url,ts_headline('simple',private.page_text(data),plainto_tsquery('simple',p_query)) as snippet,'page' as kind,updated_at
    from public.pages where deleted_at is null and search_tsv @@ plainto_tsquery('simple',p_query)
    order by ts_rank(search_tsv,plainto_tsquery('simple',p_query)) desc limit v_limit
  ) r;
  return v_result;
end;
$$;
revoke all on function public.search_pages(text,int,text) from public;
grant execute on function public.search_pages(text,int,text) to anon,authenticated;
grant execute on function private.page_text(jsonb) to anon,authenticated;

create or replace function public.invite_member(p_workspace_id uuid, p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_token text; v_id uuid; v_url text; v_secret text;
begin
  if private.principal_type() <> 'human' or not exists(select 1 from public.workspaces where id = p_workspace_id and owner_id = auth.uid()) then raise exception using errcode = 'PT403', message = 'owner_required'; end if;
  if p_role not in ('editor','viewer') or p_role is null then raise exception using errcode = 'PT422', message = 'invalid_role'; end if;
  if coalesce(btrim(p_email),'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception using errcode = 'PT422', message = 'invalid_email'; end if;
  v_user := private.user_id_by_email(p_email);
  if v_user is not null then
    if (select raw_app_meta_data->>'principal_type' from auth.users where id=v_user) = 'agent' then raise exception using errcode = 'PT422', message = 'target_is_agent'; end if;
    if v_user = auth.uid() then raise exception using errcode = 'PT422', message = 'owner_role_fixed'; end if;
    insert into public.workspace_members(workspace_id,user_id,role,invited_by) values(p_workspace_id,v_user,p_role,auth.uid()) on conflict(workspace_id,user_id) do update set role=excluded.role,invited_by=excluded.invited_by;
    insert into public.notifications(workspace_id,user_id,kind,actor_id,actor_type,payload) values(p_workspace_id,v_user,'invite',auth.uid(),'human',jsonb_build_object('role',p_role));
    return jsonb_build_object('status','joined','user_id',v_user);
  end if;
  v_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.workspace_invitations(workspace_id,email,role,token_hash,invited_by) values(p_workspace_id,lower(btrim(p_email)),p_role,encode(extensions.digest(v_token,'sha256'),'hex'),auth.uid()) returning id into v_id;
  select value into v_url from private.app_secrets where name='project_url';
  select value into v_secret from private.app_secrets where name='cron_secret';
  if v_url is not null and v_secret is not null then
    perform net.http_post(url:=v_url||'/functions/v1/send-email',headers:=jsonb_build_object('Content-Type','application/json','x-push-secret',v_secret),body:=jsonb_build_object('invitation_id',v_id,'token',v_token));
  end if;
  return jsonb_build_object('status','invited','invitation_id',v_id,'token',v_token);
end;
$$;
revoke all on function public.invite_member(uuid,text,text) from public,anon;
grant execute on function public.invite_member(uuid,text,text) to authenticated;

create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_inv public.workspace_invitations%rowtype; v_email text;
begin
  if private.principal_type() <> 'human' or auth.uid() is null then raise exception using errcode='PT403',message='humans_only'; end if;
  select email into v_email from auth.users where id=auth.uid();
  select * into v_inv from public.workspace_invitations where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if not found or v_inv.expires_at <= now() or lower(v_email) is distinct from lower(v_inv.email) then raise exception using errcode='PT403',message='invalid_invitation'; end if;
  if v_inv.accepted_at is not null then return v_inv.workspace_id; end if;
  insert into public.workspace_members(workspace_id,user_id,role,invited_by) values(v_inv.workspace_id,auth.uid(),v_inv.role,v_inv.invited_by) on conflict(workspace_id,user_id) do nothing;
  update public.workspace_invitations set accepted_at=now() where id=v_inv.id;
  return v_inv.workspace_id;
end;
$$;
revoke all on function public.accept_invitation(text) from public,anon;
grant execute on function public.accept_invitation(text) to authenticated;

create or replace function private.workspace_directory()
returns table(workspace_id uuid,user_id uuid,display_name text,is_agent boolean)
language sql stable security definer set search_path = '' as $$
  select m.workspace_id,m.user_id,coalesce(nullif(u.raw_user_meta_data->>'full_name',''),u.email),coalesce(u.raw_app_meta_data->>'principal_type','human')='agent'
  from public.workspace_members m join auth.users u on u.id=m.user_id
  where private.is_human_member(m.workspace_id) or (private.is_agent() and exists(select 1 from public.pages p where p.workspace_id=m.workspace_id and private.agent_can_read(p.id)));
$$;
revoke all on function private.workspace_directory() from public,anon;
grant execute on function private.workspace_directory() to authenticated;
create view public.workspace_directory_v with (security_invoker=true) as select * from private.workspace_directory();
revoke all on public.workspace_directory_v from anon;
grant select on public.workspace_directory_v to authenticated;
revoke all on function private.all_blocks(jsonb),private.page_refs(jsonb),private.strip_page(jsonb),private.page_stub(text,jsonb) from public,anon,authenticated;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule(
  'send-reminders-every-minute', '* * * * *',
  $$select net.http_post(
    url := (select value from private.app_secrets where name = 'project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-push-secret',(select value from private.app_secrets where name='cron_secret')),
    body := jsonb_build_object('invoked_at',now()), timeout_milliseconds := 30000
  ) as request_id;$$
);

create or replace function public.email_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(name,value),'{}'::jsonb) from private.app_secrets
  where name in ('resend_api_key','email_from','app_url','project_url','cron_secret','send_email_hook_secret');
$$;
revoke all on function public.email_config() from public,anon,authenticated;
grant execute on function public.email_config() to service_role;
