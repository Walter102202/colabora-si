-- Human-written subtask rows remain pages until their Lead adopts them.
create table public.agent_row_plans (
  row_page_id text primary key references public.pages(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  worker_agent_id uuid references public.agents(id) on delete set null,
  updated_by uuid not null,
  updated_at timestamptz not null default now()
);
create index agent_row_plans_workspace_idx on public.agent_row_plans(workspace_id);
create index agent_row_plans_worker_idx on public.agent_row_plans(worker_agent_id);
alter table public.agent_row_plans enable row level security;
revoke all on public.agent_row_plans from public,anon,authenticated;
grant select on public.agent_row_plans to authenticated;
create policy "read plans with their row" on public.agent_row_plans for select to authenticated
  using (private.can_read_page(row_page_id,workspace_id));

create or replace function private.job_row_parent(p_row_page_id text)
returns text language sql stable security definer set search_path = '' as $$
  select parent->>'pageId' from public.pages p join public.pages d on d.id=p.parent_id and d.workspace_id=p.workspace_id,
    jsonb_array_elements(d.data->'database'->'rows') r,jsonb_array_elements(d.data->'database'->'rows') parent
   where p.id=p_row_page_id and p.deleted_at is null and d.deleted_at is null and r->>'pageId'=p.id
     and parent->>'id'=r->>'parentRowId' and nullif(parent->>'parentRowId','') is null
     and exists(select 1 from jsonb_array_elements(d.data->'database'->'properties') prop where prop->>'type'='agentStatus');
$$;
revoke all on function private.job_row_parent(text) from public,anon,authenticated;

create or replace function public.set_subtask_worker(p_row_page_id text,p_agent_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.pages%rowtype; v_parent text; v_granted jsonb := '[]';
begin
  if private.principal_type()<>'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('job-row:'||p_row_page_id,0));
  select * into v_row from public.pages where id=p_row_page_id and deleted_at is null for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if not private.can_write_page(v_row.id,v_row.workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  v_parent := private.job_row_parent(v_row.id);
  if v_parent is null then raise exception using errcode='PT422',message='not_a_subtask'; end if;
  if not private.can_write_page(v_row.parent_id,v_row.workspace_id)
     or exists(select 1 from public.private_pages where page_id in (v_row.id,v_row.parent_id,v_parent)) then
    raise exception using errcode='PT403',message='owner_required';
  end if;
  if exists(select 1 from public.agent_tasks where row_page_id=v_row.id and request_kind is null) then
    raise exception using errcode='PT409',message='subtask_started';
  end if;
  if exists(select 1 from public.agent_tasks where row_page_id=v_parent and request_kind is null)
     and not exists(select 1 from public.agent_tasks where row_page_id=v_parent and request_kind is null and state not in ('done','failed','cancelled')) then
    raise exception using errcode='PT409',message='job_finished';
  end if;
  if p_agent_id is not null then v_granted := private.grant_job_agents(v_row.parent_id,array[p_agent_id]); end if;
  insert into public.agent_row_plans(row_page_id,workspace_id,worker_agent_id,updated_by)
    values(v_row.id,v_row.workspace_id,p_agent_id,(select auth.uid()))
    on conflict(row_page_id) do update set worker_agent_id=excluded.worker_agent_id,updated_by=excluded.updated_by,updated_at=now();
  perform private.audit(v_row.workspace_id,'job.worker_set',jsonb_build_object('row_page_id',v_row.id,'worker_agent_id',p_agent_id));
  return jsonb_build_object('row_page_id',v_row.id,'worker_agent_id',p_agent_id,'granted_agents',v_granted);
end $$;
revoke all on function public.set_subtask_worker(text,uuid) from public,anon;
grant execute on function public.set_subtask_worker(text,uuid) to authenticated;

-- The check also covers direct create_agent_task calls and later reassignment through update_brief.
create or replace function private.respect_job_row_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_parent text; v_worker uuid;
begin
  if new.request_kind is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('job-row:'||new.row_page_id,0));
  v_parent := private.job_row_parent(new.row_page_id);
  if v_parent is not null and not exists(select 1 from public.agent_tasks where id=new.parent_task_id and row_page_id=v_parent) then
    raise exception using errcode='PT409',message='parent_required';
  end if;
  select worker_agent_id into v_worker from public.agent_row_plans where row_page_id=new.row_page_id for update;
  if v_worker is not null then
    if new.delegate_agent_id is null and tg_op='INSERT' then new.delegate_agent_id := v_worker;
    elsif new.delegate_agent_id is distinct from v_worker then
      raise exception using errcode='PT409',message='worker_chosen_by_person';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.respect_job_row_plan() from public,anon,authenticated;
create trigger respect_job_row_plan before insert or update of delegate_agent_id,row_page_id,parent_task_id on public.agent_tasks
  for each row execute function private.respect_job_row_plan();

create or replace function public.get_pending_job_rows(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_result jsonb;
begin
  select * into v_t from public.agent_tasks where id=p_task_id;
  if not found or v_t.delegate_agent_id is distinct from private.current_agent_id()
     or v_t.state in ('done','failed','cancelled') or not private.agent_can(v_t.row_page_id,'read')
     or not exists(select 1 from public.agents where id=v_t.delegate_agent_id and role='lead' and not is_platform) then return '[]'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('row_page_id',p.id,'row_id',r->>'id','title',p.data->>'title',
    'worker_agent_id',plan.worker_agent_id) order by ord),'[]') into v_result
    from public.pages d cross join lateral jsonb_array_elements(d.data->'database'->'rows') with ordinality item(r,ord)
    join public.pages p on p.id=r->>'pageId' and p.parent_id=d.id and p.deleted_at is null
    left join public.agent_row_plans plan on plan.row_page_id=p.id
   where d.id=v_t.db_page_id and private.job_row_parent(p.id)=v_t.row_page_id and private.agent_can(p.id,'read')
     and not exists(select 1 from public.agent_tasks t where t.row_page_id=p.id and t.request_kind is null);
  return v_result;
end $$;
revoke all on function public.get_pending_job_rows(uuid) from public,anon;
grant execute on function public.get_pending_job_rows(uuid) to authenticated;

create or replace function public.create_subtask(p_parent_task_id uuid, p_row_page_id text, p_brief jsonb,
  p_delegate_agent_id uuid default null, p_reference_task_ids uuid[] default '{}', p_depends_on_task_ids uuid[] default '{}',
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lead uuid; v_parent public.agent_tasks%rowtype; v_worker uuid;
begin
  if not private.is_agent() or private.current_agent_id() is null then
    raise exception using errcode = 'PT403', message = 'lead_only';
  end if;
  select * into v_parent from public.agent_tasks where id = p_parent_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'parent_not_found'; end if;
  v_lead := private.lead_of(p_parent_task_id);
  if v_lead is null then raise exception using errcode = 'PT403', message = 'lead_only'; end if;
  perform private.require_active_task(v_parent.id);
  perform pg_advisory_xact_lock(hashtextextended('job-row:'||p_row_page_id,0));
  select worker_agent_id into v_worker from public.agent_row_plans where row_page_id=p_row_page_id for update;
  if v_worker is not null and p_delegate_agent_id is not null and p_delegate_agent_id<>v_worker then
    raise exception using errcode='PT409',message='worker_chosen_by_person';
  end if;
  return public.create_agent_task(p_row_page_id, p_brief, coalesce(v_worker,p_delegate_agent_id), p_parent_task_id,
                                  p_reference_task_ids, p_depends_on_task_ids, p_idempotency_key);
end $$;

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
    'pending_rows',public.get_pending_job_rows(v_t.id),'workers',v_workers,'plan',coalesce(v_row.data->'blocks','[]'::jsonb),'brief',v_brief);
end $$;
revoke all on function public.join_job(text,text,uuid) from public,anon;
grant execute on function public.join_job(text,text,uuid) to authenticated;
