-- 0021_metrics: ten metrics of how agents work for people. Two security invoker RPCs: they read through
-- RLS, so a person only measures what they can see. A metric without a source says not_measured, one without data
-- says no_data, and nothing divides by zero.

create or replace function private.metric(p_key text, p_value numeric, p_unit text, p_sample int,
  p_status text default null, p_reason text default null)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'key', p_key,
    'status', coalesce(p_status, case when p_value is null then 'no_data' else 'measured' end),
    'value', case when p_status is null then p_value end,
    'unit', p_unit, 'sample', coalesce(p_sample, 0), 'reason', p_reason);
$$;

-- p_agent limits every metric to that agent's runs and requests; null measures the tasks as a whole.
create or replace function private.metrics_for(p_tasks uuid[], p_ws uuid, p_agent uuid, p_since timestamptz)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_accepted int; v_interventions int; v_lat numeric; v_lat_n int; v_reverted int; v_first numeric; v_first_n int;
  v_resume numeric; v_resume_n int; v_dups int; v_done_ops int; v_cost numeric; v_denied int := 0;
  v_has_log boolean := to_regprocedure('public.record_access_denial(text,text,uuid)') is not null;
begin
  select count(*) into v_accepted from public.agent_tasks where id = any (p_tasks) and acceptance = 'accepted';

  -- Interventions: every message a person sent on the task, answers, decisions and a release for handover included,
  -- since each one took the person's attention; left out: the start, the closing note and subtask notices.
  select count(*) into v_interventions from public.agent_activities a
   where a.task_id = any (p_tasks) and a.type = 'prompt' and a.author_type = 'human'
     and coalesce(a.body->>'signal', '') <> 'start' and not (a.body ? 'close') and not (a.body ? 'subtask_id');

  -- Decisions made by a person; automatic approvals have no decided_by and are left out on purpose.
  select percentile_cont(0.5) within group (order by extract(epoch from ap.decided_at - ap.created_at)), count(*)
    into v_lat, v_lat_n
    from public.agent_approvals ap
   where ap.task_id = any (p_tasks) and ap.decided_by is not null and ap.auto_by is null and ap.decided_at is not null
     and (p_agent is null or ap.requested_by_id = p_agent);

  select count(*) into v_reverted from public.agent_tasks t
   where t.id = any (p_tasks) and t.acceptance = 'accepted'
     and exists (select 1 from public.agent_activities a where a.task_id = t.id and a.type = 'action'
                  and a.body->>'op' = 'revert_run' and a.author_type = 'human' and a.run_id is null
                  and a.created_at > t.closed_at);

  -- First signal: the first activity of the agent on the task, the claim included on purpose: it measures how long a
  -- new task waits until an agent takes it. resume_time_s, below, measures until real work.
  select percentile_cont(0.5) within group (order by s.secs), count(*) into v_first, v_first_n
    from (select extract(epoch from min(a.created_at) - t.created_at) as secs
            from public.agent_tasks t
            join public.agent_activities a on a.task_id = t.id and a.author_type = 'agent'
            left join public.agent_runs r on r.id = a.run_id
           where t.id = any (p_tasks) and (p_agent is null or r.agent_id = p_agent)
           group by t.id, t.created_at) s;

  -- Resume: from the end of the run that handed over to the first activity of the new run that is work (not the
  -- claim, not the handover activity, not an automatic approval). claim_task of the new run writes the handover
  -- activity and names the old run in from_run_id, so the time in the queue counts: it is what a handover costs.
  -- A claim without the resume capability leaves no handover activity and is not in the sample.
  select percentile_cont(0.5) within group (order by s.secs), count(*) into v_resume, v_resume_n
    from (select extract(epoch from (
                   select min(n.created_at) from public.agent_activities n
                    where n.task_id = h.task_id and n.run_id = h.run_id and n.author_type = 'agent'
                      and n.type in ('thought','action','response')
                      and coalesce(n.body->>'op', '') not in ('claim','auto_approval')) - fr.ended_at) as secs
            from public.agent_activities h
            join public.agent_runs fr on fr.id::text = h.body->>'from_run_id' and fr.ended_at is not null
            left join public.agent_runs nr on nr.id = h.run_id
           where h.task_id = any (p_tasks) and h.type = 'handover' and (p_agent is null or nr.agent_id = p_agent)) s
   where s.secs is not null;

  select coalesce(sum(g.n - 1), 0), coalesce(sum(g.n), 0) into v_dups, v_done_ops
    from (select count(*) as n from public.external_ops o
           where o.task_id = any (p_tasks) and o.status = 'done'
             and (p_agent is null or exists (select 1 from public.agent_runs r where r.id = o.run_id and r.agent_id = p_agent))
           group by o.task_id, o.provider, o.action, o.params_hash) g;

  select coalesce(sum(r.cost_usd), 0) into v_cost from public.agent_runs r
   where r.task_id = any (p_tasks) and (p_agent is null or r.agent_id = p_agent);

  if v_has_log and private.is_workspace_owner(p_ws) then
    select count(*) into v_denied from public.audit_events e
     where e.workspace_id = p_ws and e.action = 'access.denied'
       and (p_since is null or e.created_at >= p_since)
       and ((p_agent is not null and e.target->>'agent_id' = p_agent::text)
            or (p_agent is null and (e.target->>'task_id')::uuid = any (p_tasks)));
  end if;

  return jsonb_build_array(
    private.metric('interventions_per_accepted', case when v_accepted > 0 then round(v_interventions::numeric / v_accepted, 2) end, 'per_deliverable', v_accepted),
    private.metric('decision_latency_s', case when v_lat_n > 0 then round(v_lat, 0) end, 's', v_lat_n),
    private.metric('reverted_after_accept', case when v_accepted > 0 then v_reverted end, 'tasks', v_accepted),
    private.metric('time_to_first_signal_s', case when v_first_n > 0 then round(v_first, 0) end, 's', v_first_n),
    private.metric('repeated_corrections', null, 'corrections', 0, 'not_measured', 'needs_lessons'),
    private.metric('resume_time_s', case when v_resume_n > 0 then round(v_resume, 0) end, 's', v_resume_n),
    private.metric('duplicate_effects', case when v_done_ops > 0 then v_dups end, 'ops', v_done_ops),
    private.metric('cost_per_accepted_usd', case when v_accepted > 0 then round(v_cost / v_accepted, 4) end, 'usd', v_accepted),
    private.metric('stale_knowledge_answers', null, 'answers', 0, 'not_measured', 'needs_sources'),
    case when not v_has_log then private.metric('out_of_scope_attempts', null, 'attempts', 0, 'not_measured', 'needs_denial_log')
         when not private.is_workspace_owner(p_ws) then private.metric('out_of_scope_attempts', null, 'attempts', 0, 'not_measured', 'owners_only')
         when cardinality(p_tasks) = 0 then private.metric('out_of_scope_attempts', null, 'attempts', 0)
         else private.metric('out_of_scope_attempts', v_denied, 'attempts', v_denied) end);
end $$;

-- An agent's results over a window (30 days by default): the tasks delegated to it or where it had a run.
create or replace function public.agent_metrics(p_agent_id uuid, p_since timestamptz default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_a public.agents%rowtype; v_since timestamptz := coalesce(p_since, now() - interval '30 days'); v_tasks uuid[];
begin
  select * into v_a from public.agents where id = p_agent_id;
  if not found or not private.is_human_member(v_a.workspace_id) then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  select coalesce(array_agg(t.id), '{}') into v_tasks from public.agent_tasks t
   where t.workspace_id = v_a.workspace_id and t.created_at >= v_since
     and (t.delegate_agent_id = p_agent_id or exists (select 1 from public.agent_runs r where r.task_id = t.id and r.agent_id = p_agent_id));
  return jsonb_build_object('agent_id', p_agent_id, 'since', v_since, 'tasks', cardinality(v_tasks),
                            'metrics', private.metrics_for(v_tasks, v_a.workspace_id, p_agent_id, v_since));
end $$;

-- A task's results: the task and every subtask under it.
create or replace function public.task_metrics(p_task_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_tasks uuid[];
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  -- People only, like agent_metrics: an agent reads only the approvals of its own runs and would get partial numbers.
  if not found or not private.is_human_member(v_t.workspace_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  with recursive tree(id) as (
    select p_task_id
    union
    select c.id from public.agent_tasks c join tree on c.parent_task_id = tree.id
  )
  select array_agg(id) into v_tasks from tree;
  return jsonb_build_object('task_id', p_task_id, 'tasks', cardinality(v_tasks),
                            'metrics', private.metrics_for(v_tasks, v_t.workspace_id, null, null));
end $$;

revoke all on function private.metric(text, numeric, text, int, text, text) from public, anon;
revoke all on function private.metrics_for(uuid[], uuid, uuid, timestamptz) from public, anon;
revoke all on function public.agent_metrics(uuid, timestamptz) from public, anon;
revoke all on function public.task_metrics(uuid) from public, anon;
-- Invoker functions run as the caller: authenticated needs the private helpers too.
grant execute on function private.metric(text, numeric, text, int, text, text) to authenticated;
grant execute on function private.metrics_for(uuid[], uuid, uuid, timestamptz) to authenticated;
grant execute on function public.agent_metrics(uuid, timestamptz) to authenticated;
grant execute on function public.task_metrics(uuid) to authenticated;

-- ============ denied calls (appended by the next commit) ============

-- A denied RPC rolls back and leaves no row. The MCP server reports each denial of an agent call here,
-- afterwards and best effort, so out_of_scope_attempts has a source. Only agents report, only for themselves.
create or replace function public.record_access_denial(p_tool text, p_code text, p_task_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent public.agents%rowtype; v_task uuid;
begin
  if private.principal_type() <> 'agent' then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  select * into v_agent from public.agents where id = private.current_agent_id();
  if not found then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  perform private.check_rate(v_agent.id);
  if coalesce(p_code, '') not in ('forbidden','humans_only','lead_only','direct_session_required') or coalesce(p_tool, '') !~ '^[a-z_]{1,64}$' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  if p_task_id is not null and private.can_read_task(p_task_id) then v_task := p_task_id; end if;
  if exists (select 1 from public.audit_events e
              where e.workspace_id = v_agent.workspace_id and e.action = 'access.denied' and e.actor_id = (select auth.uid())
                and e.target->>'tool' = p_tool and e.target->>'code' = p_code and e.created_at > now() - interval '1 minute') then
    return jsonb_build_object('recorded', false);
  end if;
  insert into public.audit_events (workspace_id, actor_id, actor_type, action, target)
  values (v_agent.workspace_id, (select auth.uid()), 'agent', 'access.denied',
          jsonb_build_object('tool', p_tool, 'code', p_code, 'task_id', v_task, 'agent_id', v_agent.id));
  return jsonb_build_object('recorded', true);
end $$;
revoke all on function public.record_access_denial(text, text, uuid) from public, anon;
grant execute on function public.record_access_denial(text, text, uuid) to authenticated;
