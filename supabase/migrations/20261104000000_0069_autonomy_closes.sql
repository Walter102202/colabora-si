-- Authorship is assigned at the shared write boundary for every brief-producing RPC.
create or replace function private.stamp_done_when(p_new jsonb, p_previous jsonb, p_by text)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(c || jsonb_build_object('by', coalesce(
    (select old->>'by' from jsonb_array_elements(coalesce(p_previous,'[]')) old
      where old->>'id'=c->>'id' and old->>'text'=c->>'text' limit 1),
    case when p_by in ('human','person') then 'person' else 'agent' end)) order by ord),'[]')
  from jsonb_array_elements(coalesce(p_new,'[]')) with ordinality items(c,ord);
$$;
revoke all on function private.stamp_done_when(jsonb,jsonb,text) from public,anon,authenticated;

-- Historical versions use their recorded author, not the migration principal.
update public.task_briefs set done_when=private.stamp_done_when(done_when,'[]',author_type);

create or replace function private.stamp_brief_criteria()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_previous jsonb;
begin
  select done_when into v_previous from public.task_briefs
    where task_id=new.task_id and version<new.version order by version desc limit 1;
  new.done_when := private.stamp_done_when(new.done_when,v_previous,
    coalesce(private.principal_type(),new.author_type));
  return new;
end $$;
revoke all on function private.stamp_brief_criteria() from public,anon,authenticated;
create trigger stamp_brief_criteria before insert on public.task_briefs
  for each row execute function private.stamp_brief_criteria();

create or replace function private.job_pending_human(p_job public.agent_tasks)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('criterion_id',c->>'id','text',c->>'text','task_id',t.id)
                            order by t.created_at,t.id,c->>'id'),'[]'::jsonb)
  from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version,
       jsonb_array_elements(b.done_when) c
  where t.parent_task_id=p_job.id and t.workspace_id=p_job.workspace_id and t.request_kind is null
    and t.state<>'cancelled' and t.closed_by is null and c->>'check'='human' and c->>'by'='person'
    and not (p_job.state='done' and p_job.acceptance='accepted');
$$;

-- Each counted finding belongs to the same current, approved, independent agent review.
create or replace function private.criteria_reviewed(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.subtask_review_current(p_task_id) and exists (
    select 1 from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version
      join public.agent_reviews r on r.task_id=t.id
      join public.agent_artifacts a on a.id=r.artifact_id and a.version=r.artifact_version
    where t.id=p_task_id and r.verdict='approved' and r.reviewer_type='agent'
      and r.outdated_by is null and r.brief_version=t.brief_version and a.superseded_by is null
      and not exists(select 1 from public.agent_artifacts authored where authored.task_id=t.id
        and authored.author_type=r.reviewer_type and authored.author_id=r.reviewer_id)
      and (not exists(select 1 from jsonb_array_elements(b.done_when) c where c->>'check'='ci')
        or r.artifact_id=(select newest.id from public.agent_artifacts newest where newest.task_id=t.id
          and newest.kind='diff' and newest.superseded_by is null order by newest.created_at desc,newest.id desc limit 1))
      and not exists (
        select 1 from jsonb_array_elements(b.done_when) c
        where not (c->>'check'='human' and c->>'by'='person')
          and not exists(select 1 from jsonb_array_elements(r.findings) f
            where f->>'criterion_id'=c->>'id' and f->>'status'='verified'
              and btrim(coalesce(f->>'evidence_ref',''))<>''
              and coalesce(f->>'severity','blocking')='blocking'
              and (c->>'check'<>'deterministic' or exists(
                select 1 from jsonb_array_elements(r.evidence) e where e->>'ref'=c->>'command'))))
  );
$$;
revoke all on function private.criteria_reviewed(uuid) from public,anon,authenticated;

create or replace function private.lead_may_close(p_task_id uuid, p_parent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.task_autonomy_level(p_parent_id)='autonomous'
    and private.subtask_review_current(p_task_id);
$$;

create or replace function public.close_subtask(p_task_id uuid, p_verdict text default 'accepted', p_evidence jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_t public.agent_tasks%rowtype; v_parent public.agent_tasks%rowtype; v_policies jsonb; v_ok boolean; v_review_run uuid; v_ci jsonb; v_human jsonb; v_deferred boolean := false; v_extra jsonb := '{}';
begin
  v_agent := private.current_agent_id();
  if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
  perform private.check_rate(v_agent);
  if coalesce(p_verdict, '') <> 'accepted' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id and parent_task_id is not null for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select p.* into v_parent from public.agent_tasks p where p.id = v_t.parent_task_id;
  select b.policies into v_policies from public.task_briefs b where b.task_id = v_parent.id and b.version = v_parent.brief_version;
  v_review_run := private.reviewer_run_of(v_t.id);
  if v_review_run is null and (v_parent.delegate_agent_id is distinct from v_agent
     or not exists (select 1 from public.agents where id = v_agent and role = 'lead')) then
    raise exception using errcode = 'PT403', message = 'lead_only';
  end if;
  if v_review_run is null then perform private.require_active_task(v_parent.id); end if;
  if v_t.state <> 'ready_for_review' then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  select coalesce(jsonb_agg(private.ci_criterion(v_t,c)), '[]'::jsonb) into v_ci
    from public.task_briefs b,jsonb_array_elements(b.done_when) c
    where b.task_id=v_t.id and b.version=v_t.brief_version and c->>'check'='ci';
  if exists(select 1 from jsonb_array_elements(v_ci) c where c->>'state'='failed') then
    raise exception using errcode='PT422',message='policy_denied',detail=jsonb_build_object('reason','ci_failed','checks',v_ci)::text;
  end if;
  v_deferred := exists(select 1 from jsonb_array_elements(v_ci) c where c->>'state'<>'passed');
  if private.task_autonomy_level(v_parent.id)='autonomous' then
    v_ok := private.lead_may_close(v_t.id,v_parent.id) and private.criteria_reviewed(v_t.id);
    v_deferred := false;
  elsif v_deferred then
    v_ok := private.subtask_review_current(v_t.id) and (
      coalesce(v_policies->>'subtask_close','')='lead' or private.deterministic_checks_pass(v_t.id,true,false)
      or private.lead_may_close(v_t.id,v_parent.id));
    v_extra := jsonb_build_object('ci_deferred',v_ci);
  elsif jsonb_array_length(v_ci)>0 then
    v_ok := private.deterministic_checks_pass(v_t.id,true);
  else
    v_ok := coalesce(v_policies->>'subtask_close','')='lead' or private.deterministic_checks_pass(v_t.id,true)
      or private.lead_may_close(v_t.id,v_parent.id);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('criterion_id',c->>'id','text',c->>'text','task_id',v_t.id)),'[]'::jsonb)
    into v_human from public.task_briefs b,jsonb_array_elements(b.done_when) c
    where b.task_id=v_t.id and b.version=v_t.brief_version and c->>'check'='human' and c->>'by'='person';
  if jsonb_array_length(v_human)>0 then
    if private.task_autonomy_level(v_parent.id)='autonomous' then
      raise exception using errcode='PT422',message='policy_denied',detail=jsonb_build_object('reason','human_criteria','human_deferred',v_human)::text;
    end if;
    v_ok := v_ok and private.subtask_review_current(v_t.id);
    v_extra := v_extra || jsonb_build_object('human_deferred',v_human);
  end if;
  if not v_ok then raise exception using errcode = 'PT422', message = 'policy_denied'; end if;

  update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
         waiting_on = null, updated_at = now()
   where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text', case when v_deferred then 'Closed by the lead. ' || (select string_agg('CI check "' || (c->>'check') || '" on ' || coalesce(left(c->>'sha',7),'unknown') || ' is proved on the job''s final commit.', ' ') from jsonb_array_elements(v_ci) c) when jsonb_array_length(v_human)>0 then 'Closed by the lead. Human criteria are settled with the job Accept.' when v_review_run is not null then 'Closed by the reviewer.' else 'Closed by the lead.' end, 'verdict', p_verdict, 'evidence', coalesce(p_evidence, '[]'::jsonb),
                             'rule', case when v_deferred then 'ci_deferred' when jsonb_array_length(v_human)>0 then 'human_deferred' when coalesce(v_policies->>'subtask_close', '') = 'lead' then 'policy'
                                     when private.deterministic_checks_pass(v_t.id, true) then 'deterministic' else 'lead_review' end) || v_extra,
          'agent', v_agent);
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_parent.workspace_id, v_parent.id, v_parent.active_run_id, v_parent.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', case when v_review_run is not null then 'reviewer' else 'lead' end) || v_extra,
         private.next_event_seq(v_parent.id)
   where v_parent.delegate_agent_id is not null;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close_subtask', jsonb_build_object('task_id', v_t.id));
  return jsonb_build_object('task_state', 'done') || case when v_deferred then jsonb_build_object('ci','deferred_to_job','deferred_checks',v_ci) else '{}'::jsonb end
    || case when jsonb_array_length(v_human)>0 then jsonb_build_object('human','deferred_to_job','deferred_human',v_human) else '{}'::jsonb end;
end $$;

create or replace function private.job_may_close(p_job public.agent_tasks, out allowed boolean, out reason text)
returns record language plpgsql stable security definer set search_path = '' as $$
declare v_ci jsonb;
begin
  allowed := false;
  if p_job.parent_task_id is not null or p_job.request_kind is not null or p_job.state<>'ready_for_review' then reason := 'not_delivered';
  elsif private.task_autonomy_level(p_job.id)<>'autonomous' then reason := 'autonomy';
  elsif exists(select 1 from public.agent_tasks s where s.parent_task_id=p_job.id and s.request_kind is null
                and (s.state not in ('done','cancelled') or (s.state='done' and s.acceptance<>'accepted'))) then reason := 'subtasks_open';
  elsif jsonb_array_length(private.job_pending_human(p_job))>0 or exists(select 1 from public.task_briefs b,jsonb_array_elements(b.done_when) c
                where b.task_id=p_job.id and b.version=p_job.brief_version and c->>'check'='human' and c->>'by'='person') then reason := 'human_criteria';
  else
    v_ci := private.job_ci_checks(p_job);
    if v_ci->>'state' in ('failed','pending') then reason := 'ci_' || (v_ci->>'state');
    else allowed := true; end if;
  end if;
end $$;

create or replace function public.submit_for_review(p_run_id uuid, p_summary text, p_artifact_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_uncovered text[]; v_lead uuid; v_actor uuid; v_review uuid;
begin
  v_actor := private.task_actor_agent_id();
  if v_actor is null then raise exception using errcode='PT403', message='agent_disabled'; end if;
  perform private.check_rate(v_actor);
  select * into v_r from public.agent_runs where id = p_run_id and agent_id = v_actor for update;
  if not found then raise exception using errcode='PT403', message='forbidden'; end if;
  if v_r.status not in ('running','waiting') then raise exception using errcode='PT422', message='run_not_active'; end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  if v_t.state = 'input_required' and v_t.active_run_id = v_r.id and private.task_waits_on_human(v_t.id) then
    raise exception using errcode = 'PT409', message = 'waiting_on_human',
      detail = jsonb_build_object('approval_ids', (select coalesce(jsonb_agg(a.id order by a.created_at), '[]'::jsonb)
                                                     from public.agent_approvals a
                                                    where a.task_id = v_t.id and a.status = 'pending' and a.blocking))::text;
  end if;
  if v_t.state <> 'working' or v_t.active_run_id is distinct from v_r.id then
    raise exception using errcode='PT422', message='invalid_state', detail='submit from the active run of a working task';
  end if;
  if coalesce(array_length(p_artifact_ids,1),0) = 0 then raise exception using errcode='PT422', message='artifact_required'; end if;
  if exists (select 1 from unnest(p_artifact_ids) x where not exists (
       select 1 from public.agent_artifacts a where a.id = x and a.task_id = v_t.id)) then
    raise exception using errcode='PT404', message='artifact_not_found';
  end if;

  select array_agg(c->>'id') into v_uncovered
    from public.task_briefs b, jsonb_array_elements(b.done_when) c
   where b.task_id = v_t.id and b.version = v_r.brief_version and c->>'check' <> 'human'
     and not exists (select 1 from public.agent_artifacts a where a.id = any(p_artifact_ids) and (c->>'id') = any(a.satisfies));
  if v_uncovered is not null then
    raise exception using errcode='PT422', message='criteria_uncovered', detail=to_jsonb(v_uncovered)::text;
  end if;

  -- A ci criterion is proved on a commit, so the delivery has to name one.
  select array_agg(c->>'id') into v_uncovered
    from public.task_briefs b, jsonb_array_elements(b.done_when) c
   where b.task_id = v_t.id and b.version = v_r.brief_version and c->>'check' = 'ci'
     and not exists (select 1 from public.agent_artifacts a, private.ci_commit(a.ref) k
                      where a.id = any(p_artifact_ids) and a.kind = 'diff' and (c->>'id') = any(a.satisfies));
  if v_uncovered is not null then
    raise exception using errcode='PT422', message='ci_commit_required', detail=to_jsonb(v_uncovered)::text;
  end if;

  if v_t.parent_task_id is null and v_t.request_kind is null
     and jsonb_array_length(private.task_ci_requirements(v_t))>0
     and not exists(select 1 from public.agent_artifacts a,private.ci_commit(a.ref) k
                     where a.id=any(p_artifact_ids) and a.task_id=v_t.id and a.kind='diff' and a.superseded_by is null) then
    raise exception using errcode='PT422',message='ci_commit_required',detail=jsonb_build_object(
      'checks',(select jsonb_agg(c->>'check') from jsonb_array_elements(private.task_ci_requirements(v_t)) c),
      'hint','add_artifact kind diff ref owner/repo@<sha> with the final commit of the job branch')::text;
  end if;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_r.id, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text',p_summary,'artifact_ids',to_jsonb(p_artifact_ids),'submit',true), 'agent', v_r.agent_id);
  update public.agent_runs  set status='completed', ended_at=now() where id = v_r.id;
  update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending';
  update public.agent_tasks set state='ready_for_review', review_state='pending', active_run_id=null, waiting_on=null where id = v_t.id;
  v_review := private.open_review_task(v_t, v_r.agent_id);

  select p.delegate_agent_id into v_lead from public.agent_tasks p join public.agents a on a.id=p.delegate_agent_id
   where p.id = v_t.parent_task_id and a.role='lead';
  if v_lead is not null then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.parent_task_id, null, v_lead, 'task.continue',
            jsonb_build_object('review_of', v_t.id, 'artifact_ids', to_jsonb(p_artifact_ids), 'review_task_id', v_review), private.next_event_seq(v_t.parent_task_id));
  else
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, payload)
    values (v_t.workspace_id, v_t.owner_user_id, 'ready_for_review', v_t.row_page_id, v_t.id, v_r.agent_id,
            jsonb_build_object('summary', left(p_summary, 280)));
  end if;
  -- GitHub may have completed the final checks before this delivery.
  if v_t.parent_task_id is null and v_t.request_kind is null then
    select * into v_t from public.agent_tasks where id = v_t.id;
    if private.job_ci_checks(v_t)->>'state'='passed' and (select allowed from private.job_may_close(v_t)) then
      perform private.close_job_accepted(v_t,'ci');
      return jsonb_build_object('task_state','done','review_task_id',v_review);
    end if;
  end if;
  return jsonb_build_object('task_state','ready_for_review','review_task_id',v_review);
end $$;

create or replace function private.close_job_accepted(p_job public.agent_tasks,p_by text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_ci jsonb; v_author uuid;
begin
  select * into v_t from public.agent_tasks where id=p_job.id for update;
  if not (select allowed from private.job_may_close(v_t)) then return; end if;
  v_ci := private.job_ci_checks(v_t);
  if p_by='lead' then v_author := v_t.delegate_agent_id;
  else select created_by into v_author from public.ci_connections where workspace_id=v_t.workspace_id
         and repo=v_ci->>'repo' and revoked_at is null; end if;
  update public.agent_tasks set state='done',acceptance='accepted',closed_at=now(),closed_by=null,
    active_run_id=null,waiting_on=null,updated_at=now() where id=v_t.id;
  update public.agent_approvals set status='cancelled' where task_id=v_t.id and status='pending';
  insert into public.agent_activities(workspace_id,task_id,seq,type,body,author_type,author_id)
    values(v_t.workspace_id,v_t.id,private.next_seq(v_t.id),'response',jsonb_build_object(
      'text',case when v_ci->>'state'='passed' then 'Closed: CI passed on ' || left(v_ci->>'sha',7) || ' and every subtask was reviewed.' else 'Closed: the Lead verified the deliveries and every subtask was accepted.' end,
      'rule','ci_job','sha',v_ci->>'sha','checks',v_ci->'checks'),case when p_by='lead' then 'agent' else 'system' end,v_author);
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id,'task.close_job',jsonb_build_object('task_id',v_t.id,'by',p_by,'sha',v_ci->>'sha'));
  insert into public.agent_events(workspace_id,task_id,agent_id,type,payload,seq)
    select v_t.workspace_id,v_t.id,v_t.delegate_agent_id,'task.updated',jsonb_build_object('job_state','done','ci',v_ci),private.next_event_seq(v_t.id)
    where v_t.delegate_agent_id is not null;
end $$;
