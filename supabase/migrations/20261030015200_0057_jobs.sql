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
