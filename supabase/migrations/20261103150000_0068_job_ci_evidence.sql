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
