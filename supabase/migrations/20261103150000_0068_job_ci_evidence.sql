-- CI belongs to the job's final commit. Requirements are derived from current briefs.
create or replace function private.task_ci_requirements(p_task public.agent_tasks)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('check', name, 'sources', sources) order by name), '[]'::jsonb)
  from (
    select c->>'command' as name, jsonb_agg(distinct t.id) as sources
    from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version,
         jsonb_array_elements(b.done_when) c
    where t.workspace_id=p_task.workspace_id and c->>'check'='ci'
      and (t.id=p_task.id or (p_task.parent_task_id is null and p_task.request_kind is null
           and t.parent_task_id=p_task.id and t.request_kind is null and t.state <> 'cancelled'))
    group by c->>'command'
  ) requirements;
$$;
revoke all on function private.task_ci_requirements(public.agent_tasks) from public, anon, authenticated;

create or replace function private.job_ci_checks(p_job public.agent_tasks)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_repo text; v_sha text; v_connected boolean; v_c jsonb; v_state text; v_checks jsonb := '[]';
        v_run public.ci_check_runs%rowtype; v_branch text; v_completed timestamptz; v_newer text;
begin
  select k.repo,k.sha into v_repo,v_sha from public.agent_artifacts a, private.ci_commit(a.ref) k
    where a.task_id=p_job.id and a.kind='diff' and a.superseded_by is null
    order by a.created_at desc,a.id desc limit 1;
  v_connected := exists (select 1 from public.ci_connections c where c.workspace_id=p_job.workspace_id
                          and (v_repo is null or c.repo=v_repo) and c.revoked_at is null);
  for v_c in select value from jsonb_array_elements(private.task_ci_requirements(p_job)) loop
    v_state := case when v_sha is null then 'no_commit' when not v_connected then 'not_connected' else 'pending' end;
    if v_state='pending' then
      select r.* into v_run from public.ci_check_runs r join public.ci_connections c on c.id=r.connection_id
        where r.workspace_id=p_job.workspace_id and r.repo=v_repo and r.head_sha=v_sha and r.name=v_c->>'check'
          and c.revoked_at is null and r.completed_at>=p_job.created_at
        order by r.completed_at desc,r.check_run_id desc limit 1;
      if found then
        v_state := case when v_run.conclusion='success' then 'passed' else 'failed' end;
        v_c := v_c || jsonb_build_object('url',v_run.html_url);
      end if;
    end if;
    v_checks := v_checks || jsonb_build_array(v_c || jsonb_build_object('state',v_state));
  end loop;
  select c->>'state' into v_state from jsonb_array_elements(v_checks) c
    order by case c->>'state' when 'failed' then 0 when 'no_commit' then 1 when 'not_connected' then 2 when 'pending' then 3 else 4 end limit 1;
  select r.head_branch,r.completed_at into v_branch,v_completed from public.ci_check_runs r
    join public.ci_connections c on c.id=r.connection_id and c.revoked_at is null
    where r.workspace_id=p_job.workspace_id and r.repo=v_repo and r.head_sha=v_sha
    order by r.completed_at desc,r.check_run_id desc limit 1;
  select left(r.head_sha,7) into v_newer from public.ci_check_runs r
    join public.ci_connections c on c.id=r.connection_id and c.revoked_at is null
    where r.workspace_id=p_job.workspace_id and r.repo=v_repo and r.head_branch=v_branch
      and r.completed_at>v_completed and r.head_sha<>v_sha
    order by r.completed_at desc,r.check_run_id desc limit 1;
  return jsonb_build_object('state',coalesce(v_state,'none'),'repo',v_repo,'sha',v_sha,'checks',v_checks,
                           'connected',v_connected,'newer_commit',v_newer);
end $$;
revoke all on function private.job_ci_checks(public.agent_tasks) from public, anon, authenticated;

create or replace function public.job_ci_status(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype;
begin
  select * into v_t from public.agent_tasks where id=p_task_id;
  if not found or not private.can_read_page(v_t.row_page_id,v_t.workspace_id) then
    raise exception using errcode='PT404', message='not_found';
  end if;
  if v_t.parent_task_id is not null or v_t.request_kind is not null then
    return '{"state":"none","checks":[],"connected":false}'::jsonb;
  end if;
  return private.job_ci_checks(v_t);
end $$;
revoke all on function public.job_ci_status(uuid) from public, anon;
grant execute on function public.job_ci_status(uuid) to authenticated;

create or replace function private.deterministic_checks_pass(p_task_id uuid, p_lead_close boolean, p_ci boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and (c->>'check' = 'deterministic' or (p_ci and c->>'check' = 'ci')))
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and (c->>'check' = 'deterministic' or (p_ci and c->>'check' = 'ci'))
         and not exists (
           select 1 from public.agent_reviews r, jsonb_array_elements(r.findings) f
            where r.task_id = t.id and r.outdated_by is null and (r.direct_session or (p_lead_close and r.reviewer_type = 'agent'))
              and f->>'criterion_id' = c->>'id' and f->>'status' = 'verified'
              and coalesce(f->>'severity', 'blocking') = 'blocking'
                   and not exists (select 1 from public.agent_artifacts authored
                     where authored.task_id=t.id and private.same_artifact_ref(authored.ref,(select ref from public.agent_artifacts where id=r.artifact_id))
                       and authored.author_type = r.reviewer_type and authored.author_id = r.reviewer_id)
              -- A new commit has a different ref, so it does not supersede the old artifact or its review.
              and (c->>'check' <> 'ci' or (r.brief_version = t.brief_version

                   and (r.artifact_id, r.artifact_version) = (
                     select a.id, a.version from public.agent_artifacts a, private.ci_commit(a.ref) k
                      where a.task_id = t.id and a.kind = 'diff' and a.superseded_by is null
                        and (c->>'id') = any(a.satisfies)
                        and a.id=(select newest.id from public.agent_artifacts newest where newest.task_id=t.id and newest.kind='diff' and newest.superseded_by is null order by newest.created_at desc,newest.id desc limit 1)
                      order by a.created_at desc, a.id desc limit 1)))
              and (c->>'check' = 'ci' or (jsonb_array_length(r.evidence) > 0
                   and (c->>'command' is null or exists (
                         select 1 from jsonb_array_elements(r.evidence) e where e->>'ref' = c->>'command'))))))
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and p_ci and c->>'check' = 'ci' and private.ci_criterion(t, c)->>'state' <> 'passed');
$$;

revoke all on function private.deterministic_checks_pass(uuid,boolean,boolean) from public,anon,authenticated;
create or replace function private.deterministic_checks_pass(p_task_id uuid, p_lead_close boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.deterministic_checks_pass(p_task_id,p_lead_close,true);
$$;

create or replace function private.deterministic_checks_pass(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.deterministic_checks_pass(p_task_id, false);
$$;

revoke execute on function private.deterministic_checks_pass(uuid, boolean) from public, anon, authenticated;


-- A different commit ref does not set outdated_by: bind CI review to the newest live diff explicitly.
create or replace function private.subtask_review_current(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agent_tasks t join public.agent_reviews r on r.task_id=t.id
    join public.agent_artifacts reviewed on reviewed.id=r.artifact_id and reviewed.version=r.artifact_version
    where t.id=p_task_id and t.review_state='approved' and r.verdict='approved'
      and r.outdated_by is null and r.brief_version=t.brief_version and reviewed.superseded_by is null
      and (r.reviewer_type='agent' or (r.reviewer_type='human' and r.direct_session))
      and not exists (select 1 from public.agent_artifacts a where a.task_id=t.id
                       and a.author_type=r.reviewer_type and a.author_id=r.reviewer_id)
      and (not exists (select 1 from public.task_briefs b,jsonb_array_elements(b.done_when) c
                        where b.task_id=t.id and b.version=t.brief_version and c->>'check'='ci')
           or r.artifact_id=(select a.id from public.agent_artifacts a where a.task_id=t.id
                             and a.kind='diff' and a.superseded_by is null order by a.created_at desc,a.id desc limit 1))
  );
$$;
revoke all on function private.subtask_review_current(uuid) from public,anon,authenticated;

create or replace function private.lead_may_close(p_task_id uuid, p_parent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.task_autonomy_level(p_parent_id)='autonomous'
    and not exists (select 1 from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version,
                     jsonb_array_elements(b.done_when) c where t.id=p_task_id and c->>'check' in ('human','deterministic'))
    and private.subtask_review_current(p_task_id);
$$;
create or replace function public.close_subtask(p_task_id uuid, p_verdict text default 'accepted', p_evidence jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_t public.agent_tasks%rowtype; v_parent public.agent_tasks%rowtype; v_policies jsonb; v_ok boolean; v_review_run uuid; v_ci jsonb; v_deferred boolean := false; v_extra jsonb := '{}';
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
  if v_deferred then
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
  if not v_ok then raise exception using errcode = 'PT422', message = 'policy_denied'; end if;

  update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
         waiting_on = null, updated_at = now()
   where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text', case when v_deferred then 'Closed by the lead. ' || (select string_agg('CI check "' || (c->>'check') || '" on ' || coalesce(left(c->>'sha',7),'unknown') || ' is proved on the job''s final commit.', ' ') from jsonb_array_elements(v_ci) c) when v_review_run is not null then 'Closed by the reviewer.' else 'Closed by the lead.' end, 'verdict', p_verdict, 'evidence', coalesce(p_evidence, '[]'::jsonb),
                             'rule', case when v_deferred then 'ci_deferred' when coalesce(v_policies->>'subtask_close', '') = 'lead' then 'policy'
                                     when private.deterministic_checks_pass(v_t.id, true) then 'deterministic' else 'lead_review' end) || v_extra,
          'agent', v_agent);
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_parent.workspace_id, v_parent.id, v_parent.active_run_id, v_parent.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', case when v_review_run is not null then 'reviewer' else 'lead' end) || v_extra,
         private.next_event_seq(v_parent.id)
   where v_parent.delegate_agent_id is not null;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close_subtask', jsonb_build_object('task_id', v_t.id));
  return jsonb_build_object('task_state', 'done') || case when v_deferred then jsonb_build_object('ci','deferred_to_job','deferred_checks',v_ci) else '{}'::jsonb end;
end $$;

