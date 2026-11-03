-- Safe delegation roster: identities and capabilities, never connection credentials.
create or replace function public.list_agents()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_agents jsonb;
begin
  if not private.is_agent() or v_agent is null then
    raise exception using errcode='PT403',message='agents_only';
  end if;
  perform private.check_rate(v_agent);
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'role',a.role,'kind',a.kind,
    'harness',a.connection->>'harness','is_platform',a.is_platform,'me',a.id=v_agent) order by a.name,a.id),'[]')
    into v_agents from public.agents a
    where a.workspace_id=(select workspace_id from public.agents where id=v_agent)
      and a.status='enabled' and a.revoked_at is null;
  return v_agents;
end $$;
revoke all on function public.list_agents() from public,anon;
grant execute on function public.list_agents() to authenticated;

create or replace function public.join_job(p_name text,p_as text,p_job_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_matches jsonb; v_match jsonb; v_t public.agent_tasks%rowtype;
        v_row public.pages%rowtype; v_lead public.agents%rowtype; v_workers jsonb; v_subtasks jsonb; v_brief jsonb;
begin
  if v_agent is null then
    raise exception using errcode='PT403',message='agents_only';
  end if;
  if lower(p_as) not in ('lead','worker') or p_as is null or nullif(btrim(p_name),'') is null then
    raise exception using errcode='PT400',message='invalid_input';
  end if;
  perform private.check_rate(v_agent);
  select coalesce(jsonb_agg(jsonb_build_object('row_page_id',p.id,'job_id',t.id,'title',p.data->>'title',
      'database',jsonb_build_object('id',d.id,'title',case when private.agent_can(d.id,'read') then d.data->>'title' end),
      'lead_name',a.name,'kind','job') order by d.id,p.id),'[]') into v_matches
    from public.pages p join public.pages d on d.id=p.parent_id and d.workspace_id=p.workspace_id and d.deleted_at is null
    left join lateral (select x.* from public.agent_tasks x where x.row_page_id=p.id and x.request_kind is null
      and x.parent_task_id is null order by (x.state not in ('done','failed','cancelled')) desc,x.created_at desc,x.id limit 1) t on true
    left join public.agents a on a.id=t.delegate_agent_id
   where p.deleted_at is null and lower(p.data->>'title')=lower(btrim(p_name)) and private.agent_can(p.id,'read')
     and (p_job_id is null or t.id=p_job_id)
     and exists(select 1 from jsonb_array_elements(d.data->'database'->'properties') x where x->>'type'='agentStatus')
     and exists(select 1 from jsonb_array_elements(d.data->'database'->'rows') x where x->>'pageId'=p.id and nullif(x->>'parentRowId','') is null)
     and not exists(select 1 from public.agent_tasks x where x.row_page_id=p.id and x.parent_task_id is not null and x.request_kind is null);
  if jsonb_array_length(v_matches)=0 then
    select coalesce(jsonb_agg(jsonb_build_object('row_page_id',p.id,'job_id',t.id,'title',p.data->>'title',
      'database',null,'lead_name',a.name,'kind','project') order by p.id),'[]') into v_matches
      from public.pages p
      join lateral (select x.* from public.agent_tasks x where x.row_page_id=p.id and x.parent_task_id is null
        and x.request_kind is null and x.state not in ('done','failed','cancelled')
        order by x.created_at desc,x.id limit 1) t on true
      join public.agents a on a.id=t.delegate_agent_id and a.status='enabled' and a.revoked_at is null and a.role='lead'
     where p.deleted_at is null and lower(p.data->>'title')=lower(btrim(p_name)) and private.agent_can(p.id,'read')
       and (p_job_id is null or t.id=p_job_id);
  elsif exists(select 1 from public.agents where id=v_agent and is_platform) then
    -- Keep the external job crew boundary; platform agents may join projects.
    raise exception using errcode='PT403',message='agents_only';
  end if;
  if jsonb_array_length(v_matches)=0 then return jsonb_build_object('status','not_found'); end if;
  if jsonb_array_length(v_matches)>1 then return jsonb_build_object('status','ambiguous','jobs',v_matches); end if;
  v_match := v_matches->0;
  select * into v_t from public.agent_tasks where id=(v_match->>'job_id')::uuid for update;
  select * into v_lead from public.agents where id=v_t.delegate_agent_id and status='enabled' and revoked_at is null and (v_match->>'kind'='project' or not is_platform);
  if v_t.id is null or v_lead.id is null or v_lead.role<>'lead' then return v_match||jsonb_build_object('status','no_lead'); end if;
  if lower(p_as)='lead' and (v_t.delegate_agent_id<>v_agent or v_lead.role<>'lead') then
    return v_match||jsonb_build_object('status','other_lead','lead_name',v_lead.name);
  end if;
  -- Recheck the page after taking the task lock: a grant may have been removed while the name was resolved.
  if not private.agent_can(v_t.row_page_id,'read') then return jsonb_build_object('status','not_found'); end if;
  -- The Lead asked to continue its own project is never refused; everyone else needs a subtask or a named seat.
  if v_match->>'kind'='project' and lower(p_as)='worker' and v_agent<>v_t.delegate_agent_id
     and not v_agent=any(v_t.named_worker_ids)
     and not exists(select 1 from public.agent_tasks where parent_task_id=v_t.id and request_kind is null and delegate_agent_id=v_agent) then
    return v_match||jsonb_build_object('status','not_assigned');
  end if;
  if lower(p_as)='worker' and v_agent<>v_t.delegate_agent_id then
    update public.agent_tasks set
      named_worker_ids=case when v_agent=any(named_worker_ids) then named_worker_ids else array_append(named_worker_ids,v_agent) end,
      joined_worker_ids=case when v_agent=any(joined_worker_ids) then joined_worker_ids else array_append(joined_worker_ids,v_agent) end,
      updated_at=now() where id=v_t.id returning * into v_t;
  end if;
  select * into v_row from public.pages where id=v_t.row_page_id;
  select to_jsonb(b) into v_brief from public.task_briefs b where b.task_id=v_t.id and b.version=v_t.brief_version;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'joined',a.id=any(v_t.joined_worker_ids)) order by a.name,a.id),'[]')
    into v_workers from public.agents a where a.id=any(v_t.named_worker_ids)
      or (v_match->>'kind'='project' and exists(select 1 from public.agent_tasks t
        where t.parent_task_id=v_t.id and t.request_kind is null and t.delegate_agent_id=a.id));
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at,t.id),'[]') into v_subtasks from public.agent_tasks t
    where t.parent_task_id=v_t.id and t.request_kind is null and private.agent_can(t.row_page_id,'read');
  return v_match||jsonb_build_object('status','joined','lead_name',v_lead.name,'subtasks',v_subtasks,
    'pending_rows',case when v_match->>'kind'='project' then '[]'::jsonb else public.get_pending_job_rows(v_t.id) end,'workers',v_workers,'plan',coalesce(v_row.data->'blocks','[]'::jsonb),'brief',v_brief);
end $$;
revoke all on function public.join_job(text,text,uuid) from public,anon;
grant execute on function public.join_job(text,text,uuid) to authenticated;
