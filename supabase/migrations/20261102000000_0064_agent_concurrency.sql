-- Separate work and conversation capacity; external agents remain unlimited.
alter table public.agents
  add column max_active_work_runs integer check (max_active_work_runs > 0),
  add column max_active_request_runs integer check (max_active_request_runs > 0);
comment on column public.agents.max_active_work_runs is 'Maximum active work runs; null = unlimited.';
comment on column public.agents.max_active_request_runs is 'Maximum active request runs; null = unlimited.';

update public.agents set max_active_work_runs = 1, max_active_request_runs = 3
 where is_platform and max_active_work_runs is null;

create or replace function private.agents_concurrency_defaults()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_platform then
    new.max_active_work_runs := coalesce(new.max_active_work_runs, 1);
    new.max_active_request_runs := coalesce(new.max_active_request_runs, 3);
  end if;
  return new;
end $$;
revoke all on function private.agents_concurrency_defaults() from public, anon, authenticated;
create trigger agents_30_concurrency_defaults before insert on public.agents
  for each row execute function private.agents_concurrency_defaults();

create or replace function public.claim_task(p_task_id uuid default null, p_harness text default 'custom',
  p_external_session_id text default null, p_brief_version int default null, p_resume boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_task public.agent_tasks%rowtype; v_run uuid; v_brief jsonb; v_ver int; v_resume jsonb; v_open uuid[];
  v_max_work int; v_max_request int; v_limit int; v_active int; v_active_ids jsonb;
begin
  v_agent := private.task_actor_agent_id();
  if v_agent is null then raise exception using errcode='PT403', message='agent_disabled'; end if;
  perform private.check_rate(v_agent);
  if p_resume and not coalesce((select a.capabilities->'resume' = 'true'::jsonb from public.agents a where a.id = v_agent), false) then
    raise exception using errcode = 'PT422', message = 'resume_unsupported';
  end if;

  select t.* into v_task from public.agent_tasks t
   where (p_task_id is null or t.id = p_task_id)
     and t.state in ('queued','input_required','ready_for_review')
     and (t.state <> 'input_required' or t.active_run_id is not null or private.task_waits_on_human(t.id))
     and (t.delegate_agent_id = v_agent
          or (t.delegate_agent_id is null and private.agent_can(t.row_page_id,'write')))
     and (p_task_id is not null or t.state = 'queued')
     and (t.state <> 'queued' or not exists (select 1 from unnest(t.depends_on_task_ids) d
                                              join public.agent_tasks x on x.id = d where x.state <> 'done'))
   order by t.created_at
   for update skip locked limit 1;
  if not found then
    if p_task_id is null then return jsonb_build_object('task_id', null); end if;
    if exists (select 1 from public.agent_tasks t where t.id = p_task_id and t.delegate_agent_id = v_agent
                and t.state = 'input_required' and t.active_run_id is null) then
      raise exception using errcode='PT409', message='task_unavailable', detail='the task waits on a person: claim it after they answer or continue it';
    end if;
    select array_agg(x.id) into v_open from public.agent_tasks t, unnest(t.depends_on_task_ids) d
      join public.agent_tasks x on x.id = d
     where t.id = p_task_id and t.state = 'queued' and x.state <> 'done'
       and (t.delegate_agent_id = v_agent
            or (t.delegate_agent_id is null and private.agent_can(t.row_page_id, 'write')));
    if v_open is not null then
      raise exception using errcode = 'PT409', message = 'dependency_open',
        detail = jsonb_build_object('open', to_jsonb(v_open))::text;
    end if;
    raise exception using errcode='PT409', message='task_unavailable';
  end if;
  if v_task.active_run_id is not null then raise exception using errcode='PT409', message='run_active'; end if;

  perform pg_advisory_xact_lock(hashtext('agent_claim'), hashtext(v_agent::text));
  select a.max_active_work_runs, a.max_active_request_runs into v_max_work, v_max_request from public.agents a where a.id = v_agent;
  v_limit := case when v_task.request_kind is null then v_max_work else v_max_request end;
  if v_limit is not null then
    select count(*), coalesce(jsonb_agg(t.id), '[]'::jsonb) into v_active, v_active_ids
      from public.agent_tasks t join public.agent_runs r on r.id = t.active_run_id
     where r.agent_id = v_agent and t.id <> v_task.id
       and (t.request_kind is null) = (v_task.request_kind is null);
    if v_active >= v_limit then
      raise exception using errcode = 'PT409', message = 'agent_busy',
        detail = jsonb_build_object('limit', v_limit, 'active_task_ids', v_active_ids)::text;
    end if;
  end if;

  select max(version) into v_ver from public.task_briefs where task_id = v_task.id;
  if p_brief_version is not null and p_brief_version <> v_ver then
    raise exception using errcode='PT422', message='brief_version_stale', detail=jsonb_build_object('current', v_ver)::text;
  end if;

  insert into public.agent_runs (workspace_id, task_id, agent_id, harness, external_session_id, brief_version)
  values (v_task.workspace_id, v_task.id, v_agent, p_harness, p_external_session_id, v_ver)
  returning id into v_run;

  update public.agent_tasks set state='working', waiting_on=null, active_run_id=v_run,
         brief_stale=false, delegate_agent_id=coalesce(delegate_agent_id, v_agent), updated_at=now()
   where id = v_task.id;

  update public.agent_approvals set run_id = v_run where task_id = v_task.id and status in ('pending','decided');
  update public.external_ops set run_id = v_run where task_id = v_task.id and status in ('pending','unknown');
  if private.task_waits_on_human(v_task.id) then
    update public.agent_runs set status = 'waiting' where id = v_run;
    update public.agent_tasks set state = 'input_required', waiting_on = 'human' where id = v_task.id;
  end if;

  perform set_config('app.run_id', v_run::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_task.workspace_id, v_task.id, v_run, private.next_seq(v_task.id), 'action',
          jsonb_build_object('op','claim','harness',p_harness,'brief_version',v_ver), 'agent', v_agent);

  if p_resume then
    v_resume := private.resume_context(v_task.id, v_run);
    -- A handover is recorded only when the previous run ended with hand_over or a person released it after it started;
    -- the same agent claiming again after feedback is not one.
    if v_resume->'from' <> 'null'::jsonb and (
         exists (select 1 from public.agent_activities where task_id = v_task.id and type = 'checkpoint'
                  and run_id = (v_resume->'from'->>'run_id')::uuid and body->'handover' = 'true'::jsonb)
         or exists (select 1 from public.agent_activities p where p.task_id = v_task.id and p.type = 'prompt'
                  and p.body->'handover' = 'true'::jsonb
                  and p.seq > (select min(a.seq) from public.agent_activities a
                                where a.task_id = v_task.id and a.run_id = (v_resume->'from'->>'run_id')::uuid))) then
      insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
      values (v_task.workspace_id, v_task.id, v_run, private.next_seq(v_task.id), 'handover',
        jsonb_build_object('from_run_id', v_resume->'from'->'run_id', 'from_agent_id', v_resume->'from'->'agent_id',
          'from_harness', v_resume->'from'->'harness', 'to_run_id', v_run, 'to_agent_id', v_agent, 'to_harness', p_harness,
          'checkpoint_seq', v_resume->'checkpoint'->'seq', 'counts', v_resume->'counts', 'summary', v_resume->'summary'), 'agent', v_agent);
    end if;
  end if;

  select to_jsonb(b) into v_brief from public.task_briefs b where b.task_id=v_task.id and b.version=v_ver;
  return jsonb_build_object(
    'task_id', v_task.id, 'run_id', v_run, 'context_id', v_task.context_id,
    'row_page_id', v_task.row_page_id, 'brief', v_brief,
    'artifacts', (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.agent_artifacts a
                   where a.task_id=v_task.id and a.superseded_by is null),
    'recent_activities', (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
        select type, body, author_type, created_at from public.agent_activities
         where task_id=v_task.id and not ephemeral order by seq desc limit 20) x)) || case when p_resume then jsonb_build_object('resume', v_resume) else '{}'::jsonb end;
end $$;
revoke all on function public.claim_task(uuid, text, text, int, boolean) from public, anon;
grant execute on function public.claim_task(uuid, text, text, int, boolean) to authenticated;
