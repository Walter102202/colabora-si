-- Owner-controlled roles and agent ceilings. Null autonomy inherits the workspace.
alter table public.agents add column autonomy text check (autonomy in ('ask','balanced','autonomous'));

create or replace function public.set_agent_autonomy(p_agent_id uuid, p_level text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_a from public.agents where id = p_agent_id and revoked_at is null for update;
  if not found or not private.is_workspace_member(v_a.workspace_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_owner(v_a.workspace_id) then raise exception using errcode = 'PT403', message = 'owner_required'; end if;
  if v_a.is_platform then raise exception using errcode = 'PT422', message = 'platform_agent'; end if;
  if p_level is not null and p_level not in ('ask','balanced','autonomous') then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  update public.agents set autonomy = p_level, updated_at = now() where id = v_a.id;
  perform private.audit(v_a.workspace_id, 'agent.autonomy_set', jsonb_build_object('agent_id', v_a.id, 'from', v_a.autonomy, 'to', p_level));
  return jsonb_build_object('agent_id', v_a.id, 'level', p_level, 'previous', v_a.autonomy);
end $$;
revoke all on function public.set_agent_autonomy(uuid, text) from public, anon;
grant execute on function public.set_agent_autonomy(uuid, text) to authenticated;

create or replace function public.set_agent_role(p_agent_id uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_title text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_a from public.agents where id = p_agent_id and revoked_at is null for update;
  if not found or not private.is_workspace_member(v_a.workspace_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_owner(v_a.workspace_id) then raise exception using errcode = 'PT403', message = 'owner_required'; end if;
  if v_a.is_platform then raise exception using errcode = 'PT422', message = 'platform_agent'; end if;
  if p_role is null or p_role not in ('lead','worker') then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if v_a.role = 'lead' and p_role = 'worker' then
    select coalesce(p.data->>'title', b.objective, 'Untitled job') into v_title
      from public.agent_tasks t join public.pages p on p.id = t.row_page_id
      left join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version
     where t.delegate_agent_id = v_a.id and t.request_kind is null and t.state not in ('done','failed','cancelled')
       and (t.parent_task_id is null or exists (
         select 1 from public.agent_tasks child where child.parent_task_id = t.id and child.state not in ('done','failed','cancelled')))
     order by t.created_at, t.id limit 1;
    if found then raise exception using errcode = 'PT409', message = 'lead_has_open_work', detail = v_title; end if;
  end if;
  update public.agents set role = p_role, updated_at = now() where id = v_a.id;
  perform private.audit(v_a.workspace_id, 'agent.role_set', jsonb_build_object('agent_id', v_a.id, 'from', v_a.role, 'to', p_role));
  return jsonb_build_object('agent_id', v_a.id, 'role', p_role, 'previous', v_a.role);
end $$;
revoke all on function public.set_agent_role(uuid, text) from public, anon;
grant execute on function public.set_agent_role(uuid, text) to authenticated;

create or replace function private.own_autonomy_level(p_task_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_p public.agent_task_policies%rowtype; v_ws text;
        v_agent text; v_level text; v_found_policy boolean;
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found then return 'ask'; end if;
  v_ws := private.workspace_autonomy(v_t.workspace_id);
  select autonomy into v_agent from public.agents where id = v_t.delegate_agent_id;
  select * into v_p from public.agent_task_policies where task_id = v_t.id;
  v_found_policy := found;
  if v_ws = 'ask' then return 'ask'; end if;
  if v_found_policy then
    v_level := case when private.is_owner_user(v_t.workspace_id, v_p.set_by) then v_p.autonomy
                    else private.autonomy_min(v_p.autonomy, v_ws) end;
  else
    v_level := coalesce(v_agent, v_ws);
  end if;
  if v_agent is not null then v_level := private.autonomy_min(v_level, v_agent); end if;
  return v_level;
end $$;

create or replace function private.action_allowed(p_action text, p_task_id uuid, p_depth int default 0)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_required text[];
begin
  if p_action = 'payment' then return null; end if;
  if p_depth >= 10 or coalesce(p_action, '') = '' then return null; end if;
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found then return null; end if;
  -- Workspace Ask is the global stop, including trusted brief preapprovals.
  if private.workspace_autonomy(v_t.workspace_id) = 'ask' then return null; end if;
  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  -- Fails closed: an action it names asks, and a shape it cannot read makes every action ask.
  v_required := private.required_actions(v_b.policies);
  if v_required is null or p_action = any (v_required) then return null; end if;
  if v_t.parent_task_id is not null and private.action_allowed(p_action, v_t.parent_task_id, p_depth + 1) is null then
    return null;
  end if;
  if p_action = any (private.autonomy_preset(private.task_autonomy_level(v_t.id))) then return 'preset'; end if;
  if jsonb_typeof(v_b.policies -> 'preapproved') = 'array' and (v_b.policies -> 'preapproved') ? p_action
     and private.policy_action_trusted(v_b,p_action) then
    return 'brief';
  end if;
  return null;
end $$;

create or replace function public.task_autonomy(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_req text; v_own text; v_level text; v_auto text[];
        v_candidates text[]; v_agent text;
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found or not private.can_read_task(p_task_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  select autonomy into v_req from public.agent_task_policies where task_id = v_t.id;
  select autonomy into v_agent from public.agents where id = v_t.delegate_agent_id;
  v_own := private.own_autonomy_level(v_t.id);
  v_level := private.task_autonomy_level(v_t.id);
  -- The actions that can ever run without asking: the highest preset and what the brief preapproves.
  select coalesce(array_agg(s.a order by s.a), '{}') into v_candidates
    from (select distinct x as a
            from unnest(private.autonomy_preset('autonomous')
                        || coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_b.policies->'preapproved') = 'array'
                                                                                 then v_b.policies->'preapproved' else '[]'::jsonb end)), '{}')) x) s;
  select coalesce(array_agg(c order by c), '{}') into v_auto from unnest(v_candidates) c where private.action_allowed(c, v_t.id) is not null;
  return jsonb_build_object(
    'level', v_level, 'requested', v_req,
    'source', case when private.workspace_autonomy(v_t.workspace_id) = 'ask' then 'workspace'
                   when v_level <> v_own then 'parent'
                   when v_req is not null and v_own = v_req then 'task'
                   when v_agent is not null and v_own = v_agent then 'agent' else 'workspace' end,
    'workspace_level', private.workspace_autonomy(v_t.workspace_id),
    'auto_approved', to_jsonb(v_auto),
    'merge_rule', private.merge_rule_state(v_t.id),
    -- What the brief makes ask, always as a list; for a shape the server cannot read, every action that could run alone.
    'require_approval', to_jsonb(coalesce(private.required_actions(v_b.policies), v_candidates)),
    -- Whether set_task_autonomy would let the caller change the level: the workspace owner, from the app itself.
    'can_edit', private.is_workspace_owner(v_t.workspace_id) and private.jwt_client_id() is null);
end $$;
