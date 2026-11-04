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

-- Human criteria are settled once by the job Accept; agent closure never settles them.
create or replace function private.job_pending_human(p_job public.agent_tasks)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('criterion_id',c->>'id','text',c->>'text','task_id',t.id)
                            order by t.created_at,t.id,c->>'id'),'[]'::jsonb)
  from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version,
       jsonb_array_elements(b.done_when) c
  where t.parent_task_id=p_job.id and t.workspace_id=p_job.workspace_id and t.request_kind is null
    and t.state<>'cancelled' and t.closed_by is null and c->>'check'='human'
    and not (p_job.state='done' and p_job.acceptance='accepted');
$$;
revoke all on function private.job_pending_human(public.agent_tasks) from public,anon,authenticated;

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
                           'connected',v_connected,'newer_commit',v_newer,'pending_human',private.job_pending_human(p_job));
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
                     jsonb_array_elements(b.done_when) c where t.id=p_task_id and c->>'check' = 'deterministic')
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
  select coalesce(jsonb_agg(jsonb_build_object('criterion_id',c->>'id','text',c->>'text','task_id',v_t.id)),'[]'::jsonb)
    into v_human from public.task_briefs b,jsonb_array_elements(b.done_when) c
    where b.task_id=v_t.id and b.version=v_t.brief_version and c->>'check'='human';
  if jsonb_array_length(v_human)>0 then
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


create or replace function public.close_task(p_task_id uuid, p_acceptance text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ci jsonb; v_t public.agent_tasks%rowtype; v_sub public.agent_tasks%rowtype; v_run public.agent_runs%rowtype; v_uid uuid := (select auth.uid());
begin
  if private.principal_type() <> 'human' then raise exception using errcode='PT403', message='humans_only'; end if;
  if p_acceptance is null or p_acceptance not in ('accepted','rejected') then
    raise exception using errcode='PT400', message='invalid_input';
  end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode='PT404', message='not_found'; end if;
  if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then raise exception using errcode='PT403', message='forbidden'; end if;
  -- Closing without a delivery requires 'rejected'; an escalated task with a delivery may be accepted (D10).
  if v_t.state not in ('ready_for_review','input_required')
     or (v_t.state = 'input_required' and p_acceptance <> 'rejected'
         and not exists (select 1 from public.agent_artifacts a where a.task_id = v_t.id and a.superseded_by is null)) then
    raise exception using errcode='PT422', message='invalid_state';
  end if;

  if v_t.parent_task_id is null and v_t.request_kind is null and p_acceptance='accepted' then
    v_ci := private.job_ci_checks(v_t);
    if v_ci->>'state' in ('pending','failed') then
      raise exception using errcode='PT422',message='ci_' || (v_ci->>'state'),detail=v_ci::text;
    end if;
  end if;
  if v_t.active_run_id is not null then
    update public.agent_runs set stop_requested_at = coalesce(stop_requested_at, now()) where id = v_t.active_run_id
      returning * into v_run;
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.id, v_run.id, v_run.agent_id, 'task.stop', jsonb_build_object('reason', 'closed'),
            private.next_event_seq(v_t.id));
  end if;
  update public.agent_approvals set status = 'cancelled' where task_id = v_t.id and status = 'pending';
  update public.agent_tasks set state='done', acceptance=p_acceptance, closed_at=now(), closed_by=v_uid, active_run_id=null,
         waiting_on=null, updated_at=now()
   where id=v_t.id;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'prompt',
          jsonb_build_object('text', coalesce(p_note, ''), 'signal', 'feedback', 'source', 'row_panel', 'close', p_acceptance),
          'human', v_uid);
  if v_t.parent_task_id is not null then
    insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
    values (v_t.workspace_id, v_t.parent_task_id, null, private.next_seq(v_t.parent_task_id), 'prompt',
            jsonb_build_object('text', 'Subtask "' || v_t.title || '" closed by a person: ' || p_acceptance
                                       || coalesce('. ' || p_note, ''),
                               'signal', 'feedback', 'source', 'row_panel', 'subtask_id', v_t.id),
            'human', v_uid);
  end if;
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select p.workspace_id, p.id, p.active_run_id, p.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', p_acceptance, 'closed_by', 'human'),
         private.next_event_seq(p.id)
    from public.agent_tasks p
   where p.id = v_t.parent_task_id and p.delegate_agent_id is not null;
  -- One Accept settles a job and its deliveries. Rejecting a job leaves them for the person to read.
  if p_acceptance = 'accepted' and v_t.parent_task_id is null then
    for v_sub in select * from public.agent_tasks s
                  where s.parent_task_id = v_t.id and s.request_kind is null and s.state = 'ready_for_review'
                    and private.can_write_page(s.row_page_id, s.workspace_id)
                  order by s.created_at, s.id for update loop
      update public.agent_approvals set status = 'cancelled' where task_id = v_sub.id and status = 'pending';
      update public.agent_tasks set state='done', acceptance='accepted', closed_at=now(), closed_by=v_uid, active_run_id=null,
             waiting_on=null, updated_at=now()
       where id=v_sub.id;
      insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
      values (v_sub.workspace_id, v_sub.id, null, private.next_seq(v_sub.id), 'prompt',
              jsonb_build_object('text', 'Accepted with its job.', 'signal', 'feedback', 'source', 'row_panel', 'close', 'accepted'),
              'human', v_uid);
      perform private.release_dependents(v_sub.id);
      perform private.audit(v_sub.workspace_id, 'task.close', jsonb_build_object('task_id', v_sub.id, 'acceptance', 'accepted', 'with_job', v_t.id));
    end loop;
  end if;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close', jsonb_build_object('task_id', v_t.id, 'acceptance', p_acceptance));
  return jsonb_build_object('task_state', 'done', 'acceptance', p_acceptance);
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
    if (select allowed from private.job_may_close(v_t)) then
      perform private.close_job_accepted(v_t,'ci');
      return jsonb_build_object('task_state','done','review_task_id',v_review);
    end if;
  end if;
  return jsonb_build_object('task_state','ready_for_review','review_task_id',v_review);
end $$;
-- Both outputs are explicit: Postgres cannot declare OUT text with RETURNS boolean.
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
                where b.task_id=p_job.id and b.version=p_job.brief_version and c->>'check'='human') then reason := 'human_criteria';
  else
    v_ci := private.job_ci_checks(p_job);
    if v_ci->>'state'='passed' then allowed := true;
    else reason := 'ci_' || (v_ci->>'state'); end if;
  end if;
end $$;
revoke all on function private.job_may_close(public.agent_tasks) from public,anon,authenticated;

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
      'text','Closed: CI passed on ' || left(v_ci->>'sha',7) || ' and every subtask was reviewed.',
      'rule','ci_job','sha',v_ci->>'sha','checks',v_ci->'checks'),case when p_by='lead' then 'agent' else 'system' end,v_author);
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id,'task.close_job',jsonb_build_object('task_id',v_t.id,'by',p_by,'sha',v_ci->>'sha'));
  insert into public.agent_events(workspace_id,task_id,agent_id,type,payload,seq)
    select v_t.workspace_id,v_t.id,v_t.delegate_agent_id,'task.updated',jsonb_build_object('job_state','done','ci',v_ci),private.next_event_seq(v_t.id)
    where v_t.delegate_agent_id is not null;
end $$;
revoke all on function private.close_job_accepted(public.agent_tasks,text) from public,anon,authenticated;

create or replace function public.close_job(p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_t public.agent_tasks%rowtype; v_allowed boolean; v_reason text;
begin
  if v_agent is null then raise exception using errcode='PT403',message='lead_only'; end if;
  perform private.check_rate(v_agent);
  select * into v_t from public.agent_tasks where id=p_task_id and parent_task_id is null for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if v_t.delegate_agent_id is distinct from v_agent or not exists(select 1 from public.agents where id=v_agent and role='lead') then
    raise exception using errcode='PT403',message='lead_only';
  end if;
  if not private.can_write_page(v_t.row_page_id,v_t.workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  select allowed,reason into v_allowed,v_reason from private.job_may_close(v_t);
  if not v_allowed then raise exception using errcode='PT422',message='policy_denied',
    detail=jsonb_build_object('reason',v_reason,'ci',private.job_ci_checks(v_t))::text; end if;
  perform private.close_job_accepted(v_t,'lead');
  return '{"task_state":"done"}'::jsonb;
end $$;
revoke all on function public.close_job(uuid) from public,anon;
grant execute on function public.close_job(uuid) to authenticated;

create or replace function public.record_ci_check(p_connection_id uuid, p_repo text, p_run jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.ci_connections%rowtype; v_sha text; v_name text; v_conclusion text; v_url text; v_rows int;
        v_t public.agent_tasks%rowtype; v_ci jsonb; v_passed boolean; v_tasks int := 0; v_job public.agent_tasks%rowtype; v_jobs uuid[] := array[]::uuid[];
begin
  select * into v_c from public.ci_connections where id = p_connection_id;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if v_c.revoked_at is not null then raise exception using errcode = 'PT410', message = 'connection_revoked'; end if;
  if lower(coalesce(p_repo, '')) <> v_c.repo then raise exception using errcode = 'PT403', message = 'repo_mismatch'; end if;
  update public.ci_connections set last_delivery_at = now() where id = v_c.id;
  if p_run is null then return jsonb_build_object('recorded', false); end if;

  v_sha := lower(coalesce(p_run->>'head_sha', ''));
  v_name := p_run->>'name';
  v_conclusion := p_run->>'conclusion';
  v_url := p_run->>'html_url';
  begin
    insert into public.ci_check_runs (connection_id, check_run_id, workspace_id, repo, head_sha, head_branch, name, conclusion,
                                      html_url, app_slug, started_at, completed_at)
    values (v_c.id, (p_run->>'id')::bigint, v_c.workspace_id, v_c.repo, v_sha, p_run->>'head_branch', v_name, v_conclusion,
            v_url, p_run->>'app_slug', (p_run->>'started_at')::timestamptz, (p_run->>'completed_at')::timestamptz)
    on conflict (connection_id, check_run_id) do nothing;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('recorded', false); end if;

  v_passed := v_conclusion = 'success';
  v_ci := jsonb_build_object('check', v_name, 'conclusion', v_conclusion, 'sha', v_sha, 'url', v_url);
  for v_t in
    select t.* from public.agent_tasks t
     where t.workspace_id = v_c.workspace_id and t.state in ('working','input_required','ready_for_review')
       and t.created_at <= (p_run->>'completed_at')::timestamptz
       and exists (select 1 from public.agent_artifacts a
                    where a.workspace_id = v_c.workspace_id and a.task_id = t.id and a.kind = 'diff' and a.superseded_by is null
                      and lower(a.ref) in (v_c.repo || '@' || v_sha, 'https://github.com/' || v_c.repo || '/commit/' || v_sha))
       and exists (select 1 from jsonb_array_elements(private.task_ci_requirements(t)) c where c->>'check'=v_name)
     order by t.id for update of t
  loop
    v_tasks := v_tasks + 1;
    v_jobs := array_append(v_jobs,coalesce(v_t.parent_task_id,v_t.id));
    insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
    values (v_t.workspace_id, v_t.id, v_t.active_run_id, private.next_seq(v_t.id), 'response',
            jsonb_build_object('text', 'CI: ' || v_name || case when v_passed then ' passed on ' else ' did not pass on ' end || left(v_sha, 7) || '.', 'ci', v_ci),
            'system', v_c.created_by);
    -- The Lead decides on the subtask either way; the worker only needs to hear about a failure.
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    select p.workspace_id, p.id, p.active_run_id, p.delegate_agent_id, 'task.updated',
           jsonb_build_object('subtask_id', v_t.id, 'ci', v_ci), private.next_event_seq(p.id)
      from public.agent_tasks p
     where p.id = v_t.parent_task_id and p.delegate_agent_id is not null;
    if not v_passed and v_t.delegate_agent_id is not null then
      insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
      values (v_t.workspace_id, v_t.id, v_t.active_run_id, v_t.delegate_agent_id, 'task.updated',
              jsonb_build_object('ci', v_ci), private.next_event_seq(v_t.id));
    end if;
  end loop;
  for v_job in select * from public.agent_tasks where id=any(v_jobs) and parent_task_id is null order by id for update loop
    if (select allowed from private.job_may_close(v_job)) then perform private.close_job_accepted(v_job,'ci'); end if;
  end loop;
  return jsonb_build_object('recorded', true, 'tasks', v_tasks);
end $$;
revoke all on function public.record_ci_check(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_ci_check(uuid, text, jsonb) to service_role;
