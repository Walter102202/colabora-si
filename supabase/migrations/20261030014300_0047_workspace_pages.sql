-- 0047: workspace page operations. The core below preserves 0029 and adds one internal operation.
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
      when 'workspace_patch' then
        if coalesce(current_setting('app.workspace_write', true), '') <> '1' then
          raise exception using errcode='PT403', message='forbidden';
        end if;
        select coalesce(jsonb_object_agg(key,value),'{}') into v_patch
          from jsonb_each(v_op->'patch') where key in ('parentId','isDeleted','database');
        select coalesce(jsonb_object_agg(key,v_data->key),'{}') into v_array from jsonb_object_keys(v_patch) key;
        v_undo := jsonb_build_object('op','workspace_patch','patch',v_array);
        v_data := v_data || v_patch;
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

create or replace function private.inherit_private_page()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_parent public.private_pages%rowtype;
begin
  select * into v_parent from public.private_pages where page_id=new.parent_id;
  if found then
    -- Trusted SQL maintenance has no API role. All user updates, including OAuth, are checked.
    if tg_op='UPDATE' and current_setting('role',true) in ('authenticated','anon') then
      if auth.uid() is distinct from v_parent.owner_user_id or private.principal_type()<>'human'
         or private.jwt_client_id() is not null then
        raise exception using errcode='PT403',message='forbidden';
      end if;
      if exists (
        select 1 from private.page_subtree(new.id) s join public.pages p on p.id=s
        where p.published or exists(select 1 from public.private_pages x where x.page_id=s and x.owner_user_id<>auth.uid())
          or (not exists(select 1 from public.private_pages x where x.page_id=s) and (
            exists(select 1 from public.workspace_members m where m.workspace_id=p.workspace_id and m.user_id<>auth.uid())
            or exists(select 1 from public.page_shares sh where sh.page_id=s and sh.user_id<>auth.uid())
            or exists(select 1 from public.agent_grants g where g.page_id=s and g.revoked_at is null)))
      ) then raise exception using errcode='PT403',message='page_shared'; end if;
    end if;
    insert into public.private_pages(page_id,workspace_id,owner_user_id,root_page_id)
      select id,v_parent.workspace_id,v_parent.owner_user_id,v_parent.root_page_id from private.page_subtree(new.id) id
      on conflict(page_id) do nothing;
  end if;
  return null;
end $$;

-- Check visibility before lock status; archived pages are admitted only for archive/restore and retry checks.
create or replace function private.workspace_page(p_id text, p_archived boolean default false)
returns public.pages language plpgsql security definer set search_path='' as $$
declare p public.pages%rowtype;
begin
  select * into p from public.pages where id=p_id;
  if not found or p.data is null then raise exception using errcode='PT404',message='not_found'; end if;
  if private.is_agent() and private.current_agent_id() is null then raise exception using errcode='PT403',message='agent_disabled'; end if;
  if auth.uid() is null or not private.can_write_page(p_id,p.workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  if coalesce((p.data->>'locked')::boolean,false) then raise exception using errcode='PT423',message='page_locked'; end if;
  if p.deleted_at is not null and not p_archived then raise exception using errcode='PT404',message='not_found'; end if;
  if p.deleted_at is null then perform private.pw_page(p_id); end if;
  return p;
end $$;

create or replace function private.workspace_parent(p_id text,p_ws uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.pages%rowtype;
begin
  if p_id is not null then
    p:=private.workspace_page(p_id);
    if p_ws is not null and p_ws<>p.workspace_id then raise exception using errcode='PT403',message='cross_workspace'; end if;
    return p.workspace_id;
  end if;
  if private.principal_type()<>'human' then raise exception using errcode='PT403',message='parent_required'; end if;
  if auth.uid() is null or p_ws is null or not private.can_edit_workspace(p_ws) then raise exception using errcode='PT403',message='forbidden'; end if;
  return p_ws;
end $$;

create or replace function private.workspace_root_order(p_ws uuid,p_id text,p_root boolean,p_position integer default null)
returns void language plpgsql security definer set search_path='' as $$
declare a jsonb; n integer;
begin
  perform 1 from public.workspaces where id=p_ws for update;
  select coalesce(jsonb_agg(value order by ordinality),'[]') into a from public.workspaces w,
    lateral jsonb_array_elements(w.root_order) with ordinality where w.id=p_ws and value<>to_jsonb(p_id);
  if p_root then
    n:=greatest(0,least(coalesce(p_position,jsonb_array_length(a)),jsonb_array_length(a)));
    a:=jsonb_insert(a,array[n::text],to_jsonb(p_id));
  end if;
  perform set_config('app.ops_write','1',true);
  update public.workspaces set root_order=a where id=p_ws;
  perform set_config('app.ops_write','',true);
end $$;

-- Duplicate only stored, already-sanitized content; identities are remapped without accepting client Block objects.
create or replace function private.workspace_copy_json(p_value jsonb,p_map jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare out jsonb; k text; v jsonb;
begin
  if jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(private.workspace_copy_json(value,p_map) order by ordinality),'[]') into out
      from jsonb_array_elements(p_value) with ordinality;
    return out;
  elsif jsonb_typeof(p_value)='object' then
    out:='{}';
    for k,v in select * from jsonb_each(p_value) loop
      if k in ('attr','rev','comments','versions','_client','lastEditedBy','createdBy') then continue; end if;
      if k in ('id','pageId','parentId','parentRowId','syncedFrom') and p_map ? (v#>>'{}') then v:=p_map->(v#>>'{}');
      elsif k='id' and v<>'"title"'::jsonb then v:=to_jsonb(private.random_base62(12));
      else v:=private.workspace_copy_json(v,p_map); end if;
      out:=out||jsonb_build_object(k,v);
    end loop;
    if p_value->>'type'='synced' then out:=out||jsonb_build_object('syncedFrom',coalesce(p_value->>'syncedFrom',p_value->>'id')); end if;
    return out;
  end if;
  return p_value;
end $$;
revoke all on function private.workspace_copy_json(jsonb,jsonb) from public,anon,authenticated;

create table if not exists private.workspace_archived_rows (
  page_id text primary key references public.pages(id),
  database_id text not null references public.pages(id),
  row_data jsonb not null,
  after_id text,
  restored_at timestamptz
);
alter table private.workspace_archived_rows enable row level security;
revoke all on private.workspace_archived_rows from public,anon,authenticated;

create or replace function private.workspace_row_membership(p_id text,p_restore boolean)
returns void language plpgsql security definer set search_path='' as $$
declare item record; r jsonb; db public.pages%rowtype; result jsonb;
begin
  if p_restore then
    for item in select * from private.workspace_archived_rows where page_id=p_id and restored_at is null loop
      db:=private.workspace_page(item.database_id);
      if not exists(select 1 from jsonb_array_elements(db.data->'database'->'rows') x where x->>'id'=item.row_data->>'id') then
        result:=private.apply_page_ops_core(db.id,jsonb_build_array(jsonb_build_object('op','db_row_add','row',item.row_data,'after',item.after_id)),null);
      end if;
      update private.workspace_archived_rows set restored_at=now() where page_id=p_id;
    end loop;
  else
    for item in select p.id,p.data,x.value,x.ordinality from public.pages p,
      lateral jsonb_array_elements(coalesce(p.data->'database'->'rows','[]')) with ordinality x
      where p.deleted_at is null and x.value->>'pageId'=p_id loop
      db:=private.workspace_page(item.id);
      insert into private.workspace_archived_rows(page_id,database_id,row_data,after_id,restored_at)
        values(p_id,item.id,item.value,case when item.ordinality>1 then item.data->'database'->'rows'->(item.ordinality::int-2)->>'id' end,null)
        on conflict(page_id) do update set row_data=excluded.row_data,after_id=excluded.after_id,restored_at=null;
      result:=private.apply_page_ops_core(db.id,jsonb_build_array(jsonb_build_object('op','db_row_delete','rowId',item.value->>'id')),null);
    end loop;
  end if;
end $$;
revoke all on function private.workspace_row_membership(text,boolean) from public,anon,authenticated;

create or replace function private.workspace_pages(p_action text,p_input jsonb,p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.pages%rowtype; v_ws uuid; v_parent text:=p_input->>'parent_id'; v_id text:=p_input->>'page_id';
  v_result jsonb; v_data jsonb; v_blocks jsonb:='[]'; b jsonb; v_run uuid; v_res jsonb;
  v_now bigint:=(extract(epoch from now())*1000)::bigint; v_old text; v_map jsonb:='{}'; v_source public.pages%rowtype; v_ids text[]; v_copy text; v_scope text:='workspace:'||p_action;
begin
  if auth.uid() is null then raise exception using errcode='PT403',message='forbidden'; end if;
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(length(p_key),0) not between 1 and 200 then
    raise exception using errcode='PT400',message='invalid_input',hint='Supply an object and a unique idempotency_key.';
  end if;
  if p_action='create_page' then
    v_ws:=private.workspace_parent(v_parent,(p_input->>'workspace_id')::uuid);
  else
    p:=private.workspace_page(v_id,p_action in ('archive_page','restore_page'));
    v_ws:=p.workspace_id;
    if p_action in ('move_page','duplicate_page') then
      if p_action='duplicate_page' and not p_input ? 'parent_id' then v_parent:=p.parent_id; end if;
      perform private.workspace_parent(v_parent,v_ws);
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_ws::text,47));
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_scope||p_key,47));
  select result into v_result from private.write_receipts where actor_id=auth.uid() and scope=v_scope and key=p_key;
  if found then return v_result; end if;
  v_run:=private.pw_run(array[v_id,v_parent]);
  perform set_config('app.run_id',coalesce(v_run::text,''),true);
  perform set_config('app.workspace_write','1',true);
  if p_action='create_page' then
    if length(coalesce(p_input->>'title',''))>1000 or jsonb_typeof(coalesce(p_input->'blocks','[]'))<>'array'
       or jsonb_array_length(coalesce(p_input->'blocks','[]'))>200 then raise exception using errcode='PT400',message='invalid_input'; end if;
    for b in select value from jsonb_array_elements(coalesce(p_input->'blocks','[]')) loop
      v_blocks:=v_blocks||jsonb_build_array(private.render_block(b));
    end loop;
    v_id:=private.random_base62(12);
    v_data:=jsonb_build_object('id',v_id,'title',coalesce(p_input->>'title','Untitled'),'icon',p_input->'icon','parentId',v_parent,
      'blocks','[]'::jsonb,'isDeleted',false,'isFavorite',false,'fullWidth',false,'smallText',false,'createdAt',v_now,'updatedAt',v_now);
    perform set_config('app.ops_write','1',true);
    insert into public.pages(id,workspace_id,parent_id,data) values(v_id,v_ws,v_parent,v_data);
    perform set_config('app.ops_write','',true);
    if jsonb_array_length(v_blocks)>0 then
      select jsonb_agg(jsonb_build_object('op','insert_block','block',value,'after',case when ordinality=1 then null else v_blocks->(ordinality::int-2)->>'id' end) order by ordinality)
        into v_res from jsonb_array_elements(v_blocks) with ordinality;
      perform private.apply_page_ops_core(v_id,v_res,null);
    end if;
    if v_parent is null then perform private.workspace_root_order(v_ws,v_id,true); end if;
  elsif p_action='update_page' then
    if not (p_input ? 'title' or p_input ? 'icon') or length(coalesce(p_input->>'title',''))>1000 then raise exception using errcode='PT400',message='invalid_input'; end if;
    v_res:=private.apply_page_ops_core(v_id,jsonb_build_array(jsonb_build_object('op','set_page','patch',p_input-'page_id')),null);
  elsif p_action='move_page' then
    if v_parent in (select private.page_subtree(v_id)) then raise exception using errcode='PT422',message='page_cycle'; end if;
    if exists(select 1 from public.pages d,jsonb_array_elements(coalesce(d.data->'database'->'rows','[]')) r where r->>'pageId'=v_id) then
      raise exception using errcode='PT422',message='database_row',hint='Duplicate the row page instead of moving it out of its database.';
    end if;
    v_old:=p.parent_id;
    v_res:=private.apply_page_ops_core(v_id,jsonb_build_array(jsonb_build_object('op','workspace_patch','patch',jsonb_build_object('parentId',v_parent))),null);
    perform private.workspace_root_order(v_ws,v_id,v_parent is null,(p_input->>'position')::integer);
  elsif p_action in ('archive_page','restore_page') then
    -- Check every descendant first; never hide or restore content the caller cannot write.
    for b in select to_jsonb(s) from private.page_subtree(v_id) s loop perform private.workspace_page(b#>>'{}',true); end loop;
    for b in select to_jsonb(s) from private.page_subtree(v_id) s loop
      v_res:=private.apply_page_ops_core(b#>>'{}',jsonb_build_array(jsonb_build_object('op','workspace_patch','patch',jsonb_build_object('isDeleted',p_action='archive_page'))),null);
      perform private.workspace_row_membership(b#>>'{}',p_action='restore_page');
    end loop;
  elsif p_action='duplicate_page' then
    -- Database copies always include row pages; ordinary subtrees are opt-in.
    select array_agg(id) into v_ids from public.pages where id in (select private.page_subtree(v_id))
      and deleted_at is null and (id=v_id or coalesce((p_input->>'include_children')::boolean,false) or p.data ? 'database');
    if cardinality(v_ids)>200 then raise exception using errcode='PT422',message='too_many_pages'; end if;
    foreach v_copy in array v_ids loop
      perform private.workspace_page(v_copy);
      v_map:=v_map||jsonb_build_object(v_copy,private.random_base62(12));
    end loop;
    -- Preserve property/option/row ids within the new independent database so cells and views stay aligned.
    for v_source in select * from public.pages where id=any(v_ids) order by id=v_id desc loop
      v_data:=private.workspace_copy_json(v_source.data,v_map);
      if v_source.data ? 'database' then
        v_data:=jsonb_set(v_data,'{database}',v_source.data->'database');
        select coalesce(jsonb_agg(value||jsonb_build_object('pageId',v_map->(value->>'pageId'),'createdBy',auth.uid(),'lastEditedBy',auth.uid()) order by ordinality),'[]')
          into b from jsonb_array_elements(v_source.data->'database'->'rows') with ordinality;
        if exists(select 1 from jsonb_array_elements(b) r where r->'pageId'='null'::jsonb) then raise exception using errcode='PT403',message='forbidden'; end if;
        v_data:=jsonb_set(v_data,'{database,rows}',b);
        v_data:=jsonb_set(v_data,'{database,id}',to_jsonb(private.random_base62(12)));
      end if;
      v_data:=v_data||jsonb_build_object('id',v_map->v_source.id,'parentId',case when v_source.id=v_id then to_jsonb(v_parent) else v_map->v_source.parent_id end,
        'title',v_source.data->>'title'||case when v_source.id=v_id then ' (copy)' else '' end,'createdAt',v_now,'updatedAt',v_now,'isFavorite',false,'isDeleted',false);
      perform set_config('app.ops_write','1',true);
      insert into public.pages(id,workspace_id,parent_id,data) values(v_map->>v_source.id,v_ws,v_data->>'parentId',v_data);
      perform set_config('app.ops_write','',true);
    end loop;
    v_id:=v_map->>v_id;
    if v_parent is null then perform private.workspace_root_order(v_ws,v_id,true); end if;
  else raise exception using errcode='PT400',message='invalid_input'; end if;
  perform set_config('app.workspace_write','',true);
  perform set_config('app.ops_write','',true);
  select jsonb_build_object('id',id,'page_id',id,'revision',revision,'previous_parent_id',v_old) into v_result from public.pages where id=v_id;
  perform private.pw_activity(v_run,jsonb_build_object('op',p_action,'page_id',v_id,'summary',p_action),coalesce(v_res->'inverse','[]'));
  insert into private.write_receipts(scope,key,actor_id,result) values(v_scope,p_key,auth.uid(),v_result);
  perform set_config('app.run_id','',true);
  return v_result;
end $$;

create or replace function public.create_page(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_pages('create_page',p_input,p_idempotency_key);
$$;
revoke all on function public.create_page(jsonb,text) from public,anon;
grant execute on function public.create_page(jsonb,text) to authenticated;

create or replace function public.update_page(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_pages('update_page',p_input,p_idempotency_key);
$$;
revoke all on function public.update_page(jsonb,text) from public,anon;
grant execute on function public.update_page(jsonb,text) to authenticated;

create or replace function public.move_page(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_pages('move_page',p_input,p_idempotency_key);
$$;
revoke all on function public.move_page(jsonb,text) from public,anon;
grant execute on function public.move_page(jsonb,text) to authenticated;

create or replace function public.duplicate_page(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_pages('duplicate_page',p_input,p_idempotency_key);
$$;
revoke all on function public.duplicate_page(jsonb,text) from public,anon;
grant execute on function public.duplicate_page(jsonb,text) to authenticated;

create or replace function public.archive_page(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_pages('archive_page',p_input,p_idempotency_key);
$$;
revoke all on function public.archive_page(jsonb,text) from public,anon;
grant execute on function public.archive_page(jsonb,text) to authenticated;

create or replace function public.restore_page(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_pages('restore_page',p_input,p_idempotency_key);
$$;
revoke all on function public.restore_page(jsonb,text) from public,anon;
grant execute on function public.restore_page(jsonb,text) to authenticated;

revoke all on function private.workspace_page(text,boolean) from public,anon,authenticated;

revoke all on function private.workspace_parent(text,uuid) from public,anon,authenticated;

revoke all on function private.workspace_root_order(uuid,text,boolean,integer) from public,anon,authenticated;

revoke all on function private.workspace_pages(text,jsonb,text) from public,anon,authenticated;

-- Only the checked workspace dispatcher may change agent-owned structure; identity/publication stay protected.
create or replace function private.protect_page_columns()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not private.can_edit_workspace(old.workspace_id) and (
    new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
    or new.published is distinct from old.published or new.created_at is distinct from old.created_at
    or ((new.parent_id is distinct from old.parent_id or new.deleted_at is distinct from old.deleted_at)
      and coalesce(current_setting('app.workspace_write',true),'')<>'1')
  ) then raise exception using errcode='PT403',message='protected_page_columns'; end if;
  return new;
end $$;

-- Publication serves the public site; workspace tools still honor private ownership.
create or replace view public.workspace_visible_pages with (security_invoker=true) as
  select * from public.pages where not private.page_hidden(id) and private.can_read_page(id,workspace_id);
revoke all on public.workspace_visible_pages from public,anon;
grant select on public.workspace_visible_pages to authenticated;

create or replace function public.workspace_page_bundle(p_page_id text,p_max_pages integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b jsonb; visible jsonb; synced jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.pages p where p.id=p_page_id
    and not private.page_hidden(p.id) and private.can_read_page(p.id,p.workspace_id)) then return null; end if;
  b:=public.get_page_bundle(p_page_id,p_max_pages);
  if b is null then return null; end if;
  select coalesce(jsonb_object_agg(e.key,e.value),'{}') into visible from jsonb_each(b->'pages') e
    join public.pages p on p.id=e.key where not private.page_hidden(p.id) and private.can_read_page(p.id,p.workspace_id);
  select coalesce(jsonb_object_agg(e.key,e.value),'{}') into synced from jsonb_each(coalesce(b->'syncedBlocks','{}')) e
    where exists(select 1 from jsonb_each(visible||jsonb_build_object(p_page_id,b->'page')) vp,
      lateral private.all_blocks(vp.value) bl where bl->>'type'='synced' and coalesce(bl->>'syncedFrom',bl->>'id')=e.key)
    and not exists(select 1 from public.pages source,lateral private.all_blocks(source.data) sb
      where sb->>'type'='synced' and sb->>'id'=e.key
        and (private.page_hidden(source.id) or not private.can_read_page(source.id,source.workspace_id)));
  return jsonb_set(jsonb_set(b,'{pages}',visible),'{syncedBlocks}',synced);
end $$;
revoke all on function public.workspace_page_bundle(text,integer) from public,anon;
grant execute on function public.workspace_page_bundle(text,integer) to authenticated;

create or replace function public.workspace_search_pages(p_query text,p_limit integer default 10,p_kind text default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(public.search_pages(p_query,p_limit,p_kind)) r
    where exists(select 1 from public.workspace_visible_pages p where p.id=r->>'id');
$$;
revoke all on function public.workspace_search_pages(text,integer,text) from public,anon;
grant execute on function public.workspace_search_pages(text,integer,text) to authenticated;

create or replace function public.workspace_comment(p_page_id text,p_body text,p_block_id text,p_parent_id text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.pages%rowtype; r jsonb; status text;
begin
  p:=private.workspace_page(p_page_id);
  if coalesce(length(p_idempotency_key),0) not between 1 and 200 then raise exception using errcode='PT400',message='invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':comment:'||p_idempotency_key,47));
  select result into r from private.write_receipts where actor_id=auth.uid() and scope='workspace:comment' and key=p_idempotency_key;
  if found then return r; end if;
  status:=public.add_page_comment(p_page_id,p_body,p_block_id,null,p_parent_id);
  if not exists(select 1 from public.pages cp,lateral jsonb_array_elements(cp.data->'comments') c where cp.id=p_page_id and c->>'id'=status) then raise exception using errcode='PT422',message='invalid_input',detail=status; end if;
  select jsonb_build_object('id',p_page_id,'revision',revision,'comment_id',data->'comments'->-1->>'id') into r from public.pages where id=p_page_id;
  insert into private.write_receipts(scope,key,actor_id,result) values('workspace:comment',p_idempotency_key,auth.uid(),r);
  return r;
end $$;
revoke all on function public.workspace_comment(text,text,text,text,text) from public,anon;
grant execute on function public.workspace_comment(text,text,text,text,text) to authenticated;
