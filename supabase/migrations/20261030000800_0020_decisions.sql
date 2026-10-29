-- 0020_decisions: questions that do not block the task, and autonomy presets over preapproved.
-- Bodies replaced here are full copies of their latest definition; never edit an earlier migration.

-- ============ questions that do not block ============

alter table public.agent_approvals add column blocking boolean not null default true;

create or replace function private.task_waits_on_human(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agent_approvals where task_id = p_task_id and status = 'pending' and blocking);
$$;

create or replace function private.on_activity_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_tasks set last_activity_at = new.created_at, updated_at = now() where id = new.task_id;
  if new.run_id is not null then
    update public.agent_runs set last_signal_at = new.created_at, stale_at = null where id = new.run_id;
  end if;
  case new.type
    when 'elicitation' then
      -- A question asked with blocking false leaves the run and the task as they are.
      if coalesce((new.body->>'blocking')::boolean, true) then
        update public.agent_runs  set status = 'waiting' where id = new.run_id and status = 'running';
        update public.agent_tasks set state = 'input_required', waiting_on = coalesce(new.body->>'waiting_on','human')
          where id = new.task_id and state in ('working');
      end if;
    when 'error' then
      if coalesce((new.body->>'recoverable')::boolean, true) = false then
        update public.agent_runs set status = 'error', ended_at = now(), error_message = new.body->>'message'
          where id = new.run_id and status in ('running','waiting');
        if coalesce((new.body->>'terminal')::boolean, false) then
          update public.agent_tasks set state = 'failed', active_run_id = null where id = new.task_id and state <> 'done';
        else
          update public.agent_tasks set state = 'queued', active_run_id = null where id = new.task_id and state = 'working';
        end if;
      end if;
    else null;
  end case;
  return new;
end $$;

drop function public.request_input(uuid, text, text[], text);

create function public.request_input(p_run_id uuid, p_question text, p_options text[] default array['respond','ignore'],
  p_kind text default 'elicitation', p_blocking boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_id uuid;
        v_opts text[] := coalesce(p_options, array['respond','ignore']); v_blocking boolean := coalesce(p_blocking, true);
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_kind, '') not in ('elicitation','plan','escalation') or coalesce(btrim(p_question), '') = ''
     or cardinality(v_opts) = 0 or not (v_opts <@ array['approve','reject','edit','respond','ignore']) then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  insert into public.agent_approvals (workspace_id, task_id, run_id, kind, question, options, requested_by_type, requested_by_id, blocking)
  values (v_t.workspace_id, v_t.id, v_r.id, p_kind, p_question, v_opts, 'agent', v_r.agent_id, v_blocking)
  returning id into v_id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_r.id, private.next_seq(v_t.id), 'elicitation',
          jsonb_build_object('approval_id', v_id, 'question', p_question, 'options', to_jsonb(v_opts), 'blocking', v_blocking),
          'agent', v_r.agent_id);
  if v_blocking then
    update public.agent_runs set status = 'waiting' where id = v_r.id and status = 'running';
    update public.agent_tasks set state = 'input_required', waiting_on = 'human', updated_at = now()
     where id = v_t.id and state in ('working','input_required');
  end if;
  insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, approval_id, actor_id, actor_type, payload)
  values (v_t.workspace_id, v_t.owner_user_id, 'input_required', v_t.row_page_id, v_t.id, v_id, v_r.agent_id, 'agent',
          jsonb_build_object('question', left(p_question, 280), 'kind', p_kind, 'blocking', v_blocking));
  return jsonb_build_object('approval_id', v_id, 'blocking', v_blocking, 'status', 'pending');
end $$;
revoke all on function public.request_input(uuid, text, text[], text, boolean) from public, anon;
grant execute on function public.request_input(uuid, text, text[], text, boolean) to authenticated;

-- Out of independent work, the agent makes its open questions block: the task shows it waits on a person, and
-- decide_approval resumes it like any question that blocks.
create function public.await_questions(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_n int;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  update public.agent_approvals set blocking = true where run_id = v_r.id and status = 'pending' and not blocking;
  get diagnostics v_n = row_count;
  if private.task_waits_on_human(v_r.task_id) then
    update public.agent_runs set status = 'waiting' where id = v_r.id and status = 'running';
    update public.agent_tasks set state = 'input_required', waiting_on = 'human', updated_at = now()
     where id = v_r.task_id and active_run_id = v_r.id and state = 'working';
  end if;
  return jsonb_build_object('questions', v_n, 'task_state', (select state from public.agent_tasks where id = v_r.task_id));
end $$;
revoke all on function public.await_questions(uuid) from public, anon;
grant execute on function public.await_questions(uuid) to authenticated;

create or replace function public.decide_approval(p_approval_id uuid, p_decision text, p_response jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agent_approvals%rowtype; v_t public.agent_tasks%rowtype; v_receipt uuid; v_params jsonb;
begin
  if private.principal_type() <> 'human' then raise exception using errcode='PT403', message='humans_only'; end if;
  select * into v_a from public.agent_approvals where id = p_approval_id for update;
  if not found then raise exception using errcode='PT404', message='not_found'; end if;
  select * into v_t from public.agent_tasks where id = v_a.task_id;
  if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then raise exception using errcode='PT403', message='forbidden'; end if;
  if v_a.status <> 'pending' then raise exception using errcode='PT409', message='approval_not_pending'; end if;
  if v_a.expires_at < now() then update public.agent_approvals set status='expired' where id=v_a.id;
     raise exception using errcode='PT410', message='approval_expired'; end if;
  if not (p_decision = any (v_a.options)) then raise exception using errcode='PT422', message='decision_not_offered'; end if;
  -- Irreversible: a receipt that executes an action needs a session the workspace opened itself.
  if v_a.kind = 'action' and p_decision in ('approve','edit') and private.jwt_client_id() is not null then
    raise exception using errcode='PT403', message='direct_session_required';
  end if;

  v_params := v_a.params;
  if p_decision = 'edit' then v_params := coalesce(p_response->'params', v_a.params); end if;
  -- Only an approved action is executed later; a receipt for anything else would have no use.
  if v_a.kind = 'action' and p_decision in ('approve','edit') then v_receipt := gen_random_uuid(); end if;

  update public.agent_approvals
     set status='decided', decision=p_decision, response=p_response, decided_by=(select auth.uid()), decided_at=now(),
         params=v_params, action_hash=private.action_hash(action, task_id, artifact_version, v_params),
         receipt=v_receipt, receipt_expires_at = case when v_receipt is null then null else now() + interval '15 minutes' end
   where id = v_a.id;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_a.run_id, private.next_seq(v_t.id), 'prompt',
          jsonb_build_object('signal','feedback','source','row_panel','approval_id',v_a.id,'decision',p_decision,
                             'text', coalesce(p_response->>'text',''), 'blocking', v_a.blocking, 'question', left(v_a.question, 280)), 'human', (select auth.uid()));
  -- A question that does not block never paused the run or the task: nothing to resume.
  if v_a.blocking then
    update public.agent_runs  set status='running' where id = v_a.run_id and status='waiting';
    update public.agent_tasks set state = case when active_run_id is not null then 'working' else 'queued' end, waiting_on=null
     where id = v_t.id and state='input_required';
  end if;
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_t.workspace_id, v_t.id, v_a.run_id, v_t.delegate_agent_id, 'approval.decided',
         jsonb_build_object('approval_id',v_a.id,'decision',p_decision,'receipt',v_receipt,'receipt_expires_at',now()+interval '15 minutes','blocking',v_a.blocking,'kind',v_a.kind),
         private.next_event_seq(v_t.id)
   where v_t.delegate_agent_id is not null;
  insert into public.audit_events (workspace_id, actor_id, actor_type, action, target)
  values (v_t.workspace_id, (select auth.uid()), 'human', 'approval.decide', jsonb_build_object('approval_id',v_a.id,'decision',p_decision));
  return jsonb_build_object('status','decided','receipt',v_receipt,'receipt_expires_at', now()+interval '15 minutes');
end $$;

create or replace function public.touch_run_wait(p_run_id uuid, p_task_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if p_task_id is not null and not exists (select 1 from public.agent_tasks where id = p_task_id and workspace_id = v_r.workspace_id) then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  update public.agent_runs
     set last_signal_at = now(), stale_at = null, waiting_on_task_id = p_task_id,
         status = case
           when p_task_id is not null and status = 'running' then 'waiting'
           when p_task_id is null and status = 'waiting' and not exists (
             select 1 from public.agent_approvals ap where ap.run_id = v_r.id and ap.status = 'pending' and ap.blocking) then 'running'
           else status end
   where id = v_r.id;
end $$;

create or replace function public.end_run(p_run_id uuid, p_status text, p_error text default null, p_usage jsonb default null,
  p_terminal boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_state text;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if p_status is null or p_status not in ('completed','error','cancelled') then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  if p_usage is not null and (p_usage ? 'input_tokens' or p_usage ? 'output_tokens' or p_usage ? 'cost_usd') then
    perform private.record_cost_core(v_r.id, (p_usage->>'input_tokens')::bigint, (p_usage->>'output_tokens')::bigint,
                                     p_usage->>'model', (p_usage->>'cost_usd')::numeric);
  end if;

  update public.agent_runs set status = p_status, ended_at = now(), error_message = case when p_status = 'error' then p_error end,
         stop_acked_at = case when p_status = 'cancelled' and stop_requested_at is not null then now() else stop_acked_at end
   where id = v_r.id;
  v_state := case
    when p_status = 'error' and coalesce(p_terminal, false) then 'failed'
    when p_status = 'cancelled' and v_r.stop_requested_at is not null then 'cancelled'
    else 'queued' end;
  if v_state = 'queued' then
    update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending' and blocking;
    -- A question that does not block outlives a run that sends the task back to the queue: the next run gets it.
    update public.agent_approvals set run_id = null where run_id = v_r.id and status = 'pending' and not blocking;
  else
    -- The task stops or fails: nobody would read an answer, so every pending request of the run dies with it.
    update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending';
  end if;

  if p_status = 'completed' then
    insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
    select v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), 'response',
           jsonb_build_object('text', 'Run ended without a delivery.'), 'agent', v_r.agent_id
     where exists (select 1 from public.agent_tasks where id = v_r.task_id and active_run_id = v_r.id);
  end if;
  update public.agent_tasks set state = v_state, active_run_id = null, waiting_on = null, updated_at = now()
   where id = v_r.task_id and active_run_id = v_r.id;
  return jsonb_build_object('task_state', (select state from public.agent_tasks where id = v_r.task_id));
end $$;

create or replace function public.heartbeat(p_run_id uuid, p_usage jsonb default null, p_after_seq bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_from bigint;
begin
  v_r := private.own_run(p_run_id);
  update public.agent_runs set last_signal_at = now(), stale_at = null where id = v_r.id;
  if p_usage is not null and (p_usage ? 'input_tokens' or p_usage ? 'output_tokens' or p_usage ? 'cost_usd') then
    perform private.record_cost_core(v_r.id, (p_usage->>'input_tokens')::bigint, (p_usage->>'output_tokens')::bigint,
                                     p_usage->>'model', (p_usage->>'cost_usd')::numeric);
    select * into v_r from public.agent_runs where id = v_r.id;
  end if;
  v_from := coalesce(p_after_seq, (select min(seq) from public.agent_activities where run_id = v_r.id), 0);
  return jsonb_build_object(
    'stop_requested', v_r.stop_requested_at is not null and v_r.stop_acked_at is null,
    'status', v_r.status,
    'pending_prompts', (select coalesce(jsonb_agg(jsonb_build_object('seq', a.seq, 'text', a.body->>'text', 'signal', a.body->>'signal',
                                                                      'source', a.body->>'source', 'author_type', a.author_type,
                                                                      'created_at', a.created_at, 'approval_id', a.body->>'approval_id',
                                                                      'decision', a.body->>'decision') order by a.seq), '[]')
                          from public.agent_activities a
                         where a.task_id = v_r.task_id and a.type = 'prompt' and a.seq > v_from));
end $$;

create or replace function public.revoke_agent(p_agent_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_run record;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid())) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  update public.agents set status = 'disabled', revoked_at = coalesce(revoked_at, now()), updated_at = now() where id = p_agent_id;
  update public.agent_tokens set revoked_at = coalesce(revoked_at, now()) where agent_id = p_agent_id;
  update public.agent_grants set revoked_at = coalesce(revoked_at, now()) where agent_id = p_agent_id;

  for v_run in select id, task_id, workspace_id from public.agent_runs where agent_id = p_agent_id and status in ('running','waiting') loop
    update public.agent_runs set status = 'cancelled', stop_requested_at = coalesce(stop_requested_at, now()), ended_at = now()
     where id = v_run.id;
    update public.agent_approvals set status = 'cancelled' where run_id = v_run.id and status = 'pending';
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_run.workspace_id, v_run.task_id, v_run.id, p_agent_id, 'task.stop', jsonb_build_object('reason', 'agent_revoked'),
            private.next_event_seq(v_run.task_id));
  end loop;
  -- Questions that do not block outlive their run, detached from it; revoking the agent ends them too.
  update public.agent_approvals set status = 'cancelled'
   where status = 'pending' and run_id is null
     and task_id in (select id from public.agent_tasks where delegate_agent_id = p_agent_id);
  update public.agent_tasks set state = 'input_required', waiting_on = 'human', active_run_id = null, updated_at = now()
   where delegate_agent_id = p_agent_id and state in ('queued','working','input_required');
  perform private.audit(v_a.workspace_id, 'agent.revoke', jsonb_build_object('agent_id', p_agent_id, 'reason', p_reason));
end $$;

-- ============ autonomy presets (appended by the next commit) ============
