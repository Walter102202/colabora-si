-- 0048: atomic database tools through the partial-write core.
create or replace function private.workspace_property(p_db jsonb,p_ref text)
returns jsonb language plpgsql set search_path='' as $$
declare p jsonb;
begin
  select value into p from jsonb_array_elements(p_db->'properties')
    where value->>'id'=p_ref or lower(value->>'name')=lower(p_ref)
    order by (value->>'id'=p_ref) desc limit 1;
  if p is null then raise exception using errcode='PT422',message='unknown_property',
    detail=p_ref,hint='Use one of: '||(select string_agg(value->>'name',', ') from jsonb_array_elements(p_db->'properties')); end if;
  return p;
end $$;

create or replace function private.workspace_view(p_db jsonb,p_input jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v jsonb; old jsonb; x jsonb; a jsonb; k text; prop jsonb; option_id text;
begin
  if jsonb_typeof(p_input)<>'object' or coalesce(p_input->>'name','')='' then raise exception using errcode='PT422',message='invalid_view'; end if;
  select value into old from jsonb_array_elements(p_db->'views') where value->>'id'=p_input->>'name' or lower(value->>'name')=lower(p_input->>'name') limit 1;
  v:=coalesce(old,'{}')||jsonb_build_object('id',coalesce(old->>'id',private.random_base62(12)),'name',coalesce(p_input->>'rename',old->>'name',p_input->>'name'),'type',coalesce(p_input->>'type',old->>'type','table'));
  if v->>'type' not in ('table','board','list','gallery','calendar','timeline') then raise exception using errcode='PT422',message='invalid_view'; end if;
  foreach k in array array['group_by','date_property','end_date_property'] loop
    if p_input ? k then
      prop:=private.workspace_property(p_db,p_input->>k);
      v:=v||jsonb_build_object(case k when 'group_by' then 'groupBy' when 'date_property' then 'dateProp' else 'endDateProp' end,prop->'id');
    end if;
  end loop;
  foreach k in array array['sorts','filters'] loop
    if p_input ? k then
      if jsonb_typeof(p_input->k)<>'array' or jsonb_array_length(p_input->k)>30 then raise exception using errcode='PT422',message='invalid_view'; end if;
      a:='[]';
      for x in select value from jsonb_array_elements(p_input->k) loop
        prop:=private.workspace_property(p_db,x->>'property');
        if k='sorts' then
          if coalesce(x->>'direction','asc') not in ('asc','desc') then raise exception using errcode='PT422',message='invalid_view'; end if;
          a:=a||jsonb_build_object('propertyId',prop->'id','direction',coalesce(x->>'direction','asc'));
        else
          if coalesce(x->>'operator','') not in ('is','isNot','contains','notContains','isEmpty','isNotEmpty','gt','lt','checked','unchecked') then raise exception using errcode='PT422',message='invalid_view'; end if;
          if prop->>'type' in ('select','status','multiSelect') and x ? 'value' then
            select value->>'id' into option_id from jsonb_array_elements(coalesce(prop->'options','[]'))
              where value->>'id'=x->>'value' or lower(value->>'name')=lower(x->>'value') limit 1;
            if option_id is null then raise exception using errcode='PT422',message='unknown_option',hint='Use an option name or id from query_database with limit:0.'; end if;
            x:=jsonb_set(x,'{value}',to_jsonb(option_id));
          end if;
          a:=a||jsonb_build_object('id',private.random_base62(12),'propertyId',prop->'id','operator',x->'operator','value',x->'value');
        end if;
      end loop;
      v:=v||jsonb_build_object(k,a);
    end if;
  end loop;
  return v;
end $$;

create or replace function private.workspace_databases(p_action text,p_input jsonb,p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.pages%rowtype; v_ws uuid; v_id text:=p_input->>'database_id'; v_db jsonb; v_result jsonb;
 v_scope text:='workspace:'||p_action; v_props jsonb; x jsonb; prop jsonb; old jsonb; opt jsonb; opts jsonb; o jsonb;
 v_ops jsonb; res jsonb; v_run uuid; row_result jsonb; v_rows jsonb:='[]'; v_ref text; v_type text;
begin
  if auth.uid() is null then raise exception using errcode='PT403',message='forbidden'; end if;
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(length(p_key),0) not between 1 and 200 then raise exception using errcode='PT400',message='invalid_input'; end if;
  if p_action='create_database' then v_ws:=private.workspace_parent(p_input->>'parent_id',(p_input->>'workspace_id')::uuid);
  else p:=private.workspace_page(v_id); v_ws:=p.workspace_id; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_ws::text,47));
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_scope||p_key,47));
  select result into v_result from private.write_receipts where actor_id=auth.uid() and scope=v_scope and key=p_key;
  if found then return v_result; end if;
  v_run:=private.pw_run(array[v_id,p_input->>'parent_id']);
  perform set_config('app.run_id',coalesce(v_run::text,''),true);
  perform set_config('app.workspace_write','1',true);
  if p_action='create_database' then
    res:=public.create_page(p_input-'properties'-'views'-'rows',p_key||':database');
    v_id:=res->>'id';
    v_db:=jsonb_build_object('id',private.random_base62(12),'properties','[{"id":"title","name":"Name","type":"text"}]'::jsonb,'rows','[]'::jsonb,'views','[]'::jsonb);
    perform set_config('app.workspace_write','1',true);
    perform private.apply_page_ops_core(v_id,jsonb_build_array(jsonb_build_object('op','workspace_patch','patch',jsonb_build_object('database',v_db))),null);
  else
    v_db:=p.data->'database';
    if v_db is null then raise exception using errcode='PT422',message='not_a_database'; end if;
  end if;
  if p_action in ('update_database','set_view','delete_view') and coalesce((v_db->>'locked')::boolean,false) then raise exception using errcode='PT423',message='page_locked'; end if;
  if p_action in ('create_database','update_database') then
    if jsonb_typeof(coalesce(p_input->'properties','[]'))<>'array' or jsonb_array_length(coalesce(p_input->'properties','[]'))>50 then raise exception using errcode='PT422',message='invalid_input'; end if;
    for x in select value from jsonb_array_elements(coalesce(p_input->'properties','[]')) loop
      select value into old from jsonb_array_elements(v_db->'properties') where value->>'id'=x->>'name' or lower(value->>'name')=lower(x->>'name') limit 1;
      if coalesce(x->>'name','')='' then raise exception using errcode='PT422',message='invalid_input'; end if;
      if coalesce((x->>'delete')::boolean,false) then
        if old is null then perform private.workspace_property(v_db,x->>'name'); end if;
        if old->>'id'='title' then raise exception using errcode='PT422',message='title_required'; end if;
        -- Core removes property cells; views must not retain a dangling reference.
        if exists(select 1 from jsonb_array_elements(v_db->'views') vw where vw->>'groupBy'=old->>'id' or vw->>'dateProp'=old->>'id'
          or exists(select 1 from jsonb_array_elements(coalesce(vw->'sorts','[]')||coalesce(vw->'filters','[]')) z where z->>'propertyId'=old->>'id')) then
          raise exception using errcode='PT422',message='property_in_view',hint='Update or delete views using this property first.'; end if;
        v_ops:=jsonb_build_array(jsonb_build_object('op','db_prop_delete','propertyId',old->'id'));
      else
        v_type:=coalesce(x->>'type',old->>'type');
        if v_type is null or v_type not in ('text','number','checkbox','date','url','email','phone','select','multiSelect','status','person','files') then raise exception using errcode='PT422',message='computed_property'; end if;
        if old is not null and v_type<>old->>'type' then raise exception using errcode='PT422',message='property_type_change',hint='Create a new property instead; changing type can lose data.'; end if;
        prop:=coalesce(old,'{}')||jsonb_build_object('id',coalesce(old->>'id',private.random_base62(12)),'name',coalesce(x->>'rename',old->>'name',x->>'name'),'type',v_type);
        if exists(select 1 from jsonb_array_elements(v_db->'properties') z where lower(z->>'name')=lower(prop->>'name') and z->>'id'<>prop->>'id') then raise exception using errcode='PT422',message='duplicate_property'; end if;
        if x ? 'options' then
          if v_type not in ('select','multiSelect','status') or jsonb_typeof(x->'options')<>'array' then raise exception using errcode='PT422',message='invalid_input'; end if;
          opts:=coalesce(old->'options','[]');
          for o in select value from jsonb_array_elements(x->'options') loop
            if jsonb_typeof(o)='string' then o:=jsonb_build_object('name',o); end if;
            select value into opt from jsonb_array_elements(opts) where value->>'id'=o->>'name' or lower(value->>'name')=lower(o->>'name') limit 1;
            if coalesce(o->>'name','')='' then raise exception using errcode='PT422',message='invalid_input'; end if;
            if coalesce((o->>'delete')::boolean,false) then
              if exists(select 1 from jsonb_array_elements(v_db->'rows') r where r->'cells'->(prop->>'id')=opt->'id' or r->'cells'->(prop->>'id') ? (opt->>'id')) then
                raise exception using errcode='PT422',message='option_in_use',hint='Clear or change cells using this option before removing it.'; end if;
              select coalesce(jsonb_agg(value),'[]') into opts from jsonb_array_elements(opts) where value->>'id' is distinct from opt->>'id';
            else
              opt:=coalesce(opt,jsonb_build_object('id',private.random_base62(12),'color','default'))||jsonb_build_object('name',coalesce(o->>'rename',o->>'name'));
              select coalesce(jsonb_agg(value),'[]') into opts from jsonb_array_elements(opts) where value->>'id'<>opt->>'id';
              opts:=opts||opt;
            end if;
          end loop;
          prop:=prop||jsonb_build_object('options',opts);
        end if;
        v_ops:=jsonb_build_array(jsonb_build_object('op','db_prop_set','property',prop));
      end if;
      res:=private.apply_page_ops_core(v_id,v_ops,null);
      perform private.pw_activity(v_run,jsonb_build_object('op',p_action,'page_id',v_id),res->'inverse');
      select data->'database' into v_db from public.pages where id=v_id;
    end loop;
  end if;
  if p_action in ('create_database','set_view') then
    for x in select value from jsonb_array_elements(case when p_action='set_view' then jsonb_build_array(p_input->'view') else coalesce(p_input->'views','[{"name":"Table","type":"table"}]') end) loop
      res:=private.apply_page_ops_core(v_id,jsonb_build_array(jsonb_build_object('op','db_view_set','view',private.workspace_view(v_db,x))),null);
      perform private.pw_activity(v_run,jsonb_build_object('op','set_view','page_id',v_id),res->'inverse');
      select data->'database' into v_db from public.pages where id=v_id;
    end loop;
    if jsonb_array_length(v_db->'views')=0 then raise exception using errcode='PT422',message='last_view'; end if;
  elsif p_action='delete_view' then
    if jsonb_array_length(v_db->'views')<=1 then raise exception using errcode='PT422',message='last_view'; end if;
    select value->>'id' into v_ref from jsonb_array_elements(v_db->'views') where value->>'id'=p_input->>'name' or lower(value->>'name')=lower(p_input->>'name');
    if v_ref is null then raise exception using errcode='PT404',message='not_found'; end if;
    res:=private.apply_page_ops_core(v_id,jsonb_build_array(jsonb_build_object('op','db_view_delete','viewId',v_ref)),null);
    perform private.pw_activity(v_run,jsonb_build_object('op',p_action,'page_id',v_id),res->'inverse');
  end if;
  if p_action in ('create_database','add_rows') then
    if jsonb_typeof(coalesce(p_input->'rows','[]'))<>'array' or jsonb_array_length(coalesce(p_input->'rows','[]'))>100 then raise exception using errcode='PT422',message='invalid_input'; end if;
    for x in select value from jsonb_array_elements(coalesce(p_input->'rows','[]')) loop
      row_result:=public.add_row(v_id,coalesce(x->'cells','{}'),coalesce(x->'blocks','[]'),null);
      perform set_config('app.ops_write','',true);
      v_rows:=v_rows||row_result;
    end loop;
  elsif p_action='delete_row' then
    select value->>'pageId' into v_ref from jsonb_array_elements(v_db->'rows') where value->>'id'=p_input->>'row_id';
    if v_ref is null then raise exception using errcode='PT404',message='not_found'; end if;
    perform public.archive_page(jsonb_build_object('page_id',v_ref),p_key||':row');
  end if;
  perform set_config('app.workspace_write','',true);
  perform set_config('app.ops_write','',true);
  perform set_config('app.run_id','',true);
  select jsonb_build_object('id',id,'page_id',id,'revision',revision,'rows',v_rows) into v_result from public.pages where id=v_id;
  insert into private.write_receipts(scope,key,actor_id,result) values(v_scope,p_key,auth.uid(),v_result);
  return v_result;
end $$;

create or replace function public.create_database(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_databases('create_database',p_input,p_idempotency_key);
$$;
revoke all on function public.create_database(jsonb,text) from public,anon;
grant execute on function public.create_database(jsonb,text) to authenticated;

create or replace function public.update_database(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_databases('update_database',p_input,p_idempotency_key);
$$;
revoke all on function public.update_database(jsonb,text) from public,anon;
grant execute on function public.update_database(jsonb,text) to authenticated;

create or replace function public.set_view(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_databases('set_view',p_input,p_idempotency_key);
$$;
revoke all on function public.set_view(jsonb,text) from public,anon;
grant execute on function public.set_view(jsonb,text) to authenticated;

create or replace function public.delete_view(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_databases('delete_view',p_input,p_idempotency_key);
$$;
revoke all on function public.delete_view(jsonb,text) from public,anon;
grant execute on function public.delete_view(jsonb,text) to authenticated;

create or replace function public.add_rows(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_databases('add_rows',p_input,p_idempotency_key);
$$;
revoke all on function public.add_rows(jsonb,text) from public,anon;
grant execute on function public.add_rows(jsonb,text) to authenticated;

create or replace function public.delete_row(p_input jsonb,p_idempotency_key text)
returns jsonb language sql security definer set search_path='' as $$
 select private.workspace_databases('delete_row',p_input,p_idempotency_key);
$$;
revoke all on function public.delete_row(jsonb,text) from public,anon;
grant execute on function public.delete_row(jsonb,text) to authenticated;

revoke all on function private.workspace_property(jsonb,text) from public,anon,authenticated;

revoke all on function private.workspace_view(jsonb,jsonb) from public,anon,authenticated;

revoke all on function private.workspace_databases(text,jsonb,text) from public,anon,authenticated;
