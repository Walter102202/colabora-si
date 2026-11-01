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

create or replace function private.conditional_allowed(p_action text, p_run public.agent_runs, p_params jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_subject public.agent_tasks%rowtype;
        v_art public.agent_artifacts%rowtype; v_review public.agent_reviews%rowtype;
        v_conds jsonb; v_required text[]; v_up uuid; v_depth int:=0; v_repo text; v_sha text; v_c jsonb; v_ci jsonb; v_human_veto boolean;
begin
  if coalesce(p_action,'')='' or p_action='payment' or p_run.status not in ('running','waiting') or p_run.stop_requested_at is not null then return false; end if;
  select * into v_t from public.agent_tasks where id=p_run.task_id and active_run_id=p_run.id;
  if not found then return false; end if;
  if private.workspace_autonomy(v_t.workspace_id) = 'ask' then return false; end if;
  select * into v_b from public.task_briefs where task_id=v_t.id and version=v_t.brief_version;
  if not private.policy_action_trusted(v_b,p_action,true) then return false; end if;
  v_conds:=v_b.policies->'preapproved_if'->p_action;
  if jsonb_typeof(v_conds) is distinct from 'array' or jsonb_array_length(v_conds)=0
     or exists(select 1 from jsonb_array_elements_text(v_conds) c where c not in ('review_approved','ci_green')) then return false; end if;
  v_subject:=v_t;
  if coalesce(p_params->>'subtask_id','')<>'' then
    if p_params->>'subtask_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return false; end if;
    select * into v_subject from public.agent_tasks where id=(p_params->>'subtask_id')::uuid and parent_task_id=v_t.id;
    if not found then return false; end if;
  end if;
  if not (v_subject.state='ready_for_review' or (v_subject.state='done' and v_subject.acceptance='accepted')) then return false; end if;
  -- Start with the subject, so its own veto and every ancestor's veto apply.
  v_up:=v_subject.id;
  while v_up is not null and v_depth<10 loop
    select private.required_actions(b.policies),t.parent_task_id into v_required,v_up
      from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version where t.id=v_up;
    if not found or v_required is null or p_action=any(v_required) then return false; end if;
    v_depth:=v_depth+1;
  end loop;
  if v_up is not null then return false; end if;
  select * into v_art from public.agent_artifacts where task_id=v_subject.id and superseded_by is null order by created_at desc,id desc limit 1;
  if not found then return false; end if;
  -- CI and approval are one proof, even if a rule lists just one of them.
  select * into v_review from public.agent_reviews where task_id=v_subject.id order by created_at desc,id desc limit 1;
  if not found or v_review.verdict<>'approved' or not v_review.direct_session or v_review.outdated_by is not null
     or v_review.brief_version<>v_subject.brief_version or v_review.artifact_id<>v_art.id or v_review.artifact_version<>v_art.version
     or exists(select 1 from public.agent_artifacts a where a.task_id=v_subject.id and private.same_artifact_ref(a.ref,v_art.ref)
       and a.author_type=v_review.reviewer_type and a.author_id=v_review.reviewer_id) then return false; end if;
  -- A new row or spelling does not change the content a person rejected. Only their later direct approval lifts it.
  select r.verdict<>'approved' or (not r.direct_session and bool_or(r.verdict<>'approved') over()) into v_human_veto
    from public.agent_reviews r join public.agent_artifacts a on a.id=r.artifact_id and a.task_id=r.task_id
   where r.task_id=v_subject.id and r.reviewer_type='human' and private.same_artifact_ref(a.ref,v_art.ref)
     and (v_art.kind<>'page' or (a.kind='page' and (a.page_revision is null or a.page_revision=v_art.page_revision)))
   order by r.created_at desc,r.id desc limit 1;
  if coalesce(v_human_veto,false) then return false; end if;
  if v_art.kind='diff' then
    select repo,sha into v_repo,v_sha from private.ci_commit(v_art.ref);
    if v_sha is null or p_params->>'repo' is distinct from v_repo or p_params->>'head_sha' is distinct from v_sha then return false; end if;
  elsif v_art.kind='page' then
    if p_params->>'page_id' is distinct from v_art.ref
       or not exists(select 1 from public.pages p where p.id=v_art.ref and p.workspace_id=v_art.workspace_id and p.revision=v_art.page_revision and p.deleted_at is null) then return false; end if;
  else return false;
  end if;
  if v_conds ? 'ci_green' then
    if v_art.kind<>'diff' or not private.deterministic_checks_pass(v_subject.id) then return false; end if;
    select * into v_b from public.task_briefs where task_id=v_subject.id and version=v_subject.brief_version;
    if not exists(select 1 from jsonb_array_elements(v_b.done_when) c where c->>'check'='ci') then return false; end if;
    for v_c in select c from jsonb_array_elements(v_b.done_when) c where c->>'check'='ci' loop
      v_ci:=private.ci_criterion(v_subject,v_c);
      if v_ci->>'state' is distinct from 'passed' or v_ci->>'repo' is distinct from v_repo or v_ci->>'sha' is distinct from v_sha
         or not exists(select 1 from jsonb_array_elements(v_review.findings) f where f->>'criterion_id'=v_c->>'id' and f->>'status'='verified' and coalesce(f->>'severity','blocking')='blocking') then return false; end if;
    end loop;
  end if;
  return true;
end $$;
