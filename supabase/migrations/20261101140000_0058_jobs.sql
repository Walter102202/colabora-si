-- Jobs are existing top-level rows; assigning people never bypasses their page access.
alter table public.agent_tasks add column named_worker_ids uuid[] not null default '{}';
alter table public.agent_tasks add column joined_worker_ids uuid[] not null default '{}';

-- Full database access must inherit to its rows. An ancestor grant counts only while rows remain in its depth limit.
create or replace function private.grant_job_agents(p_database_id text, p_agent_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_db public.pages%rowtype; v_a public.agents%rowtype; v_id uuid; v_granted jsonb := '[]';
begin
  select * into v_db from public.pages where id=p_database_id and deleted_at is null;
  if not found or not private.can_write_page(v_db.id,v_db.workspace_id) then
    raise exception using errcode='PT403',message='owner_required';
  end if;
  for v_id in select distinct id from unnest(p_agent_ids) id order by id loop
    select * into v_a from public.agents a where a.id=v_id and a.workspace_id=v_db.workspace_id
      and a.status='enabled' and a.revoked_at is null and not a.is_platform
      and exists(select 1 from public.agent_connections c where c.agent_id=a.id and c.verified_at is not null) for update;
    if not found then raise exception using errcode='PT422',message='agent_not_available'; end if;
    if not exists (
      with recursive chain as (
        select p.id,p.parent_id,0 as depth from public.pages p where p.id=v_db.id
        union all select p.id,p.parent_id,c.depth+1 from chain c join public.pages p on p.id=c.parent_id where c.depth<2
      ) select 1 from public.agent_grants g join chain c on c.id=g.page_id
        where g.agent_id=v_id and g.inherit and g.revoked_at is null and (g.expires_at is null or g.expires_at>now())
          and g.scopes @> array['read','write','comment']
    ) then
      if not private.can_edit_workspace(v_db.workspace_id) then
        raise exception using errcode='PT403',message='owner_required',detail=v_a.name;
      end if;
      perform public.grant_agent_page(v_id,v_db.id,array['read','write','comment'],true);
      v_granted := v_granted || jsonb_build_array(jsonb_build_object('id',v_id,'name',v_a.name));
    end if;
  end loop;
  return v_granted;
end $$;
revoke all on function private.grant_job_agents(text,uuid[]) from public,anon,authenticated;

create or replace function public.assign_job(p_row_page_id text,p_lead_agent_id uuid,p_worker_agent_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.pages%rowtype; v_db public.pages%rowtype; v_task public.agent_tasks%rowtype;
        v_workers uuid[]; v_granted jsonb; v_id uuid; v_started boolean;
begin
  if private.principal_type()<>'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('job:'||p_row_page_id,0));
  select * into v_row from public.pages where id=p_row_page_id and deleted_at is null for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if not private.can_write_page(v_row.id,v_row.workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  select * into v_db from public.pages where id=v_row.parent_id and workspace_id=v_row.workspace_id and deleted_at is null;
  if not found or not exists(select 1 from jsonb_array_elements(v_db.data->'database'->'properties') p where p->>'type'='agentStatus')
     or not exists(select 1 from jsonb_array_elements(v_db.data->'database'->'rows') r where r->>'pageId'=v_row.id and nullif(r->>'parentRowId','') is null)
     or exists(select 1 from public.agent_tasks where row_page_id=v_row.id and parent_task_id is not null and request_kind is null) then
    raise exception using errcode='PT422',message='not_a_job';
  end if;
  if exists(select 1 from public.private_pages where page_id in (v_row.id,v_db.id)) then
    raise exception using errcode='PT403',message='forbidden';
  end if;
  if p_lead_agent_id is null then raise exception using errcode='PT422',message='lead_required'; end if;
  select coalesce(array_agg(distinct id order by id),'{}') into v_workers from unnest(coalesce(p_worker_agent_ids,'{}')) id;
  if array_position(v_workers,null) is not null or p_lead_agent_id=any(v_workers) then
    raise exception using errcode='PT400',message='invalid_input';
  end if;
  select * into v_task from public.agent_tasks where row_page_id=v_row.id and request_kind is null
    and state not in ('done','failed','cancelled') for update;
  v_started := v_task.id is not null and (v_task.state<>'queued' or exists(select 1 from public.agent_runs where task_id=v_task.id));
  if v_started and (v_task.delegate_agent_id is distinct from p_lead_agent_id or not v_workers @> v_task.named_worker_ids) then
    raise exception using errcode='PT409',message='job_started';
  end if;
  v_granted := private.grant_job_agents(v_db.id,array[p_lead_agent_id]||v_workers);
  if not exists(select 1 from public.agents where id=p_lead_agent_id and role='lead') then
    raise exception using errcode='PT422',message='lead_required';
  end if;
  if v_task.id is null then
    v_id := (public.create_agent_task(v_row.id,jsonb_build_object('objective',v_row.data->>'title'),p_lead_agent_id)->>'task_id')::uuid;
  else
    v_id := v_task.id;
  end if;
  update public.agent_tasks set delegate_agent_id=p_lead_agent_id,named_worker_ids=v_workers,
    joined_worker_ids=array(select id from unnest(joined_worker_ids) id where id=any(v_workers)),updated_at=now() where id=v_id;
  perform private.audit(v_row.workspace_id,'job.assign',jsonb_build_object('task_id',v_id,'lead',p_lead_agent_id,'workers',v_workers));
  return jsonb_build_object('task_id',v_id,'granted_agents',v_granted);
end $$;
revoke all on function public.assign_job(text,uuid,uuid[]) from public,anon;
grant execute on function public.assign_job(text,uuid,uuid[]) to authenticated;

-- A session joins the role already chosen on a readable row. Joining never grants page access.
create or replace function public.join_job(p_name text,p_as text,p_job_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_matches jsonb; v_match jsonb; v_t public.agent_tasks%rowtype;
        v_row public.pages%rowtype; v_lead public.agents%rowtype; v_workers jsonb; v_subtasks jsonb; v_brief jsonb;
begin
  if v_agent is null or exists(select 1 from public.agents where id=v_agent and is_platform) then
    raise exception using errcode='PT403',message='agents_only';
  end if;
  if lower(p_as) not in ('lead','worker') or p_as is null or nullif(btrim(p_name),'') is null then
    raise exception using errcode='PT400',message='invalid_input';
  end if;
  perform private.check_rate(v_agent);
  select coalesce(jsonb_agg(jsonb_build_object('row_page_id',p.id,'job_id',t.id,'title',p.data->>'title',
      'database',jsonb_build_object('id',d.id,'title',case when private.agent_can(d.id,'read') then d.data->>'title' end),
      'lead_name',a.name) order by d.id,p.id),'[]') into v_matches
    from public.pages p join public.pages d on d.id=p.parent_id and d.workspace_id=p.workspace_id and d.deleted_at is null
    left join lateral (select x.* from public.agent_tasks x where x.row_page_id=p.id and x.request_kind is null
      and x.parent_task_id is null order by (x.state not in ('done','failed','cancelled')) desc,x.created_at desc,x.id limit 1) t on true
    left join public.agents a on a.id=t.delegate_agent_id
   where p.deleted_at is null and lower(p.data->>'title')=lower(btrim(p_name)) and private.agent_can(p.id,'read')
     and (p_job_id is null or t.id=p_job_id)
     and exists(select 1 from jsonb_array_elements(d.data->'database'->'properties') x where x->>'type'='agentStatus')
     and exists(select 1 from jsonb_array_elements(d.data->'database'->'rows') x where x->>'pageId'=p.id and nullif(x->>'parentRowId','') is null)
     and not exists(select 1 from public.agent_tasks x where x.row_page_id=p.id and x.parent_task_id is not null and x.request_kind is null);
  if jsonb_array_length(v_matches)=0 then return jsonb_build_object('status','not_found'); end if;
  if jsonb_array_length(v_matches)>1 then return jsonb_build_object('status','ambiguous','jobs',v_matches); end if;
  v_match := v_matches->0;
  select * into v_t from public.agent_tasks where id=(v_match->>'job_id')::uuid for update;
  select * into v_lead from public.agents where id=v_t.delegate_agent_id and status='enabled' and revoked_at is null and not is_platform;
  if v_t.id is null or v_lead.id is null or v_lead.role<>'lead' then return v_match||jsonb_build_object('status','no_lead'); end if;
  if lower(p_as)='lead' and (v_t.delegate_agent_id<>v_agent or v_lead.role<>'lead') then
    return v_match||jsonb_build_object('status','other_lead','lead_name',v_lead.name);
  end if;
  -- Recheck the page after taking the task lock: a grant may have been removed while the name was resolved.
  if not private.agent_can(v_t.row_page_id,'read') then return jsonb_build_object('status','not_found'); end if;
  if lower(p_as)='worker' and v_agent<>v_t.delegate_agent_id then
    update public.agent_tasks set
      named_worker_ids=case when v_agent=any(named_worker_ids) then named_worker_ids else array_append(named_worker_ids,v_agent) end,
      joined_worker_ids=case when v_agent=any(joined_worker_ids) then joined_worker_ids else array_append(joined_worker_ids,v_agent) end,
      updated_at=now() where id=v_t.id returning * into v_t;
  end if;
  select * into v_row from public.pages where id=v_t.row_page_id;
  select to_jsonb(b) into v_brief from public.task_briefs b where b.task_id=v_t.id and b.version=v_t.brief_version;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'joined',a.id=any(v_t.joined_worker_ids)) order by a.name,a.id),'[]')
    into v_workers from public.agents a where a.id=any(v_t.named_worker_ids);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at,t.id),'[]') into v_subtasks from public.agent_tasks t
    where t.parent_task_id=v_t.id and t.request_kind is null and private.agent_can(t.row_page_id,'read');
  return v_match||jsonb_build_object('status','joined','lead_name',v_lead.name,'subtasks',v_subtasks,
    'workers',v_workers,'plan',coalesce(v_row.data->'blocks','[]'::jsonb),'brief',v_brief);
end $$;
revoke all on function public.join_job(text,text,uuid) from public,anon;
grant execute on function public.join_job(text,text,uuid) to authenticated;
