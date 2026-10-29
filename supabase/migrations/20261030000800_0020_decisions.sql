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
        -- The run's requests end as with end_run: all of them when the task fails; otherwise a question that does not
        -- block outlives the run, detached, and the task goes back to the queue even if it waited on a person.
        if coalesce((new.body->>'terminal')::boolean, false) then
          update public.agent_approvals set status = 'cancelled' where run_id = new.run_id and status = 'pending';
          update public.agent_tasks set state = 'failed', active_run_id = null where id = new.task_id and state <> 'done';
        else
          update public.agent_approvals set status = 'cancelled' where run_id = new.run_id and status = 'pending' and blocking;
          update public.agent_approvals set run_id = null where run_id = new.run_id and status = 'pending' and not blocking;
          -- A request outside the run that still blocks keeps the task waiting on a person (task_waits_on_human decides).
          update public.agent_tasks
             set active_run_id = null,
                 state = case when private.task_waits_on_human(new.task_id) then 'input_required' else 'queued' end,
                 waiting_on = case when private.task_waits_on_human(new.task_id) then 'human' end
           where id = new.task_id and state in ('working','input_required');
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
declare v_a public.agent_approvals%rowtype; v_t public.agent_tasks%rowtype; v_receipt uuid; v_params jsonb; v_run uuid; v_task uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode='PT403', message='humans_only'; end if;
  -- Run, task, then approval: the order the agent's RPCs lock them in, so an answer never deadlocks with the agent.
  select run_id, task_id into v_run, v_task from public.agent_approvals where id = p_approval_id;
  if not found then raise exception using errcode='PT404', message='not_found'; end if;
  if v_run is not null then perform 1 from public.agent_runs where id = v_run for update; end if;
  perform 1 from public.agent_tasks where id = v_task for update;
  select * into v_a from public.agent_approvals where id = p_approval_id for update;
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
  -- A question that does not block never paused the run or the task: nothing to resume. Nor does an answer while
  -- another request still blocks: the task keeps waiting on a person until the last one.
  if v_a.blocking and not private.task_waits_on_human(v_t.id) then
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

-- A delivery ends the run, so a question still open dies with it: an answer given during the review would otherwise
-- wake the agent as if the task had been handed over, and take the task out of review. While a request still blocks
-- (await_questions makes every open question block), the delivery waits for its answer and says which ones block.
create or replace function public.submit_for_review(p_run_id uuid, p_summary text, p_artifact_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_uncovered text[]; v_lead uuid; v_actor uuid;
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

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_r.id, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text',p_summary,'artifact_ids',to_jsonb(p_artifact_ids),'submit',true), 'agent', v_r.agent_id);
  update public.agent_runs  set status='completed', ended_at=now() where id = v_r.id;
  update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending';
  update public.agent_tasks set state='ready_for_review', review_state='pending', active_run_id=null, waiting_on=null where id = v_t.id;

  select p.delegate_agent_id into v_lead from public.agent_tasks p join public.agents a on a.id=p.delegate_agent_id
   where p.id = v_t.parent_task_id and a.role='lead';
  if v_lead is not null then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.parent_task_id, null, v_lead, 'task.continue',
            jsonb_build_object('review_of', v_t.id, 'artifact_ids', to_jsonb(p_artifact_ids)), private.next_event_seq(v_t.parent_task_id));
  else
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, payload)
    values (v_t.workspace_id, v_t.owner_user_id, 'ready_for_review', v_t.row_page_id, v_t.id, v_r.agent_id,
            jsonb_build_object('summary', left(p_summary, 280)));
  end if;
  return jsonb_build_object('task_state','ready_for_review');
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
  -- Questions that do not block outlive their run, detached from it, and a run that ended without cleaning up (an
  -- error, housekeeping) leaves its own; revoking the agent ends them too.
  update public.agent_approvals ap set status = 'cancelled'
   where ap.status = 'pending'
     and ap.task_id in (select id from public.agent_tasks where delegate_agent_id = p_agent_id)
     and not exists (select 1 from public.agent_runs r where r.id = ap.run_id and r.status in ('running','waiting'));
  update public.agent_tasks set state = 'input_required', waiting_on = 'human', active_run_id = null, updated_at = now()
   where delegate_agent_id = p_agent_id and state in ('queued','working','input_required');
  perform private.audit(v_a.workspace_id, 'agent.revoke', jsonb_build_object('agent_id', p_agent_id, 'reason', p_reason));
end $$;

-- ============ autonomy presets (appended by the next commit) ============

-- The workspace level. Its owner writes it with set_workspace_autonomy; members read it.
create table public.agent_workspace_policies (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  autonomy     text not null default 'ask' check (autonomy in ('ask','balanced','autonomous')),
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);
alter table public.agent_workspace_policies enable row level security;
create policy "members read autonomy" on public.agent_workspace_policies for select to authenticated
  using ( private.is_human_member(workspace_id) );

-- A task's own level, set by the workspace owner with set_task_autonomy. It lives apart from the brief, so changing
-- it never creates a brief version, never marks the brief stale and never outdates a review.
create table public.agent_task_policies (
  task_id  uuid primary key references public.agent_tasks(id) on delete cascade,
  autonomy text not null check (autonomy in ('ask','balanced','autonomous')),
  set_by   uuid references auth.users(id),
  set_at   timestamptz not null default now()
);
alter table public.agent_task_policies enable row level security;
create policy "task readers read task autonomy" on public.agent_task_policies for select to authenticated
  using ( private.can_read_task(task_id) );

-- Why an approval was granted without a person: the level preset or a preapproval in the brief.
alter table public.agent_approvals add column auto_by text check (auto_by in ('preset','brief'));
-- True when a person wrote the brief's preapproved list from the app itself (no OAuth chat client). Set by
-- create_agent_task, and by update_brief only when the list changes; copied otherwise.
alter table public.task_briefs add column preapproved_trusted boolean not null default false;
-- Briefs written before this migration carry no session: a person's keep their preapprovals, as before.
update public.task_briefs set preapproved_trusted = true where author_type = 'human';

-- The actions each level approves on its own. http_request is in no preset: only a preapproval covers it.
-- payment is never approved without a person (action_allowed).
create or replace function private.autonomy_preset(p_level text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_level
    when 'balanced'   then array['publish_page']
    when 'autonomous' then array['publish_page','send_email']
    else array[]::text[] end;
$$;

create or replace function private.autonomy_rank(p_level text)
returns int language sql immutable set search_path = '' as $$
  select case p_level when 'balanced' then 1 when 'autonomous' then 2 else 0 end;
$$;

create or replace function private.autonomy_min(p_a text, p_b text)
returns text language sql immutable set search_path = '' as $$
  select case when private.autonomy_rank(p_a) <= private.autonomy_rank(p_b) then coalesce(p_a, 'ask') else coalesce(p_b, 'ask') end;
$$;

create or replace function private.is_owner_user(p_ws uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_user)
      or exists (select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id = p_user and m.role = 'owner');
$$;

create or replace function private.workspace_autonomy(p_ws uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select p.autonomy from public.agent_workspace_policies p where p.workspace_id = p_ws), 'ask');
$$;

-- A task's own level, before its parent limits it: the workspace level, unless the owner set one for the task.
-- A workspace at ask caps every task (the kill switch); above ask, the owner's level holds, and a level set by
-- someone who is no longer an owner is capped by the workspace.
create or replace function private.own_autonomy_level(p_task_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_p public.agent_task_policies%rowtype; v_ws text;
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found then return 'ask'; end if;
  v_ws := private.workspace_autonomy(v_t.workspace_id);
  select * into v_p from public.agent_task_policies where task_id = v_t.id;
  if not found then return v_ws; end if;
  if v_ws = 'ask' then return 'ask'; end if;
  if private.is_owner_user(v_t.workspace_id, v_p.set_by) then return v_p.autonomy; end if;
  return private.autonomy_min(v_p.autonomy, v_ws);
end $$;

-- The level a task decides with: its own level, never above its parent's, and so on up the tree.
create or replace function private.task_autonomy_level(p_task_id uuid, p_depth int default 0)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_parent uuid; v_level text;
begin
  if p_depth >= 10 then return 'ask'; end if;
  v_level := private.own_autonomy_level(p_task_id);
  select parent_task_id into v_parent from public.agent_tasks where id = p_task_id;
  if v_parent is not null then
    v_level := private.autonomy_min(v_level, private.task_autonomy_level(v_parent, p_depth + 1));
  end if;
  return v_level;
end $$;

-- Why an action may run without asking a person: 'preset', 'brief', or null (ask). payment always asks.
-- require_approval in the brief always asks; a subtask never gets what its parent would ask for; preapproved counts
-- when a person wrote that list from the app, or for a subtask within its parent's allowance.
create or replace function private.action_allowed(p_action text, p_task_id uuid, p_depth int default 0)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype;
begin
  if p_action = 'payment' then return null; end if;
  if p_depth >= 10 or coalesce(p_action, '') = '' then return null; end if;
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found then return null; end if;
  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  -- Fails closed: one string, an element of a list or a key of an object all ask.
  if (v_b.policies -> 'require_approval') ? p_action then return null; end if;
  if v_t.parent_task_id is not null and private.action_allowed(p_action, v_t.parent_task_id, p_depth + 1) is null then
    return null;
  end if;
  if p_action = any (private.autonomy_preset(private.task_autonomy_level(v_t.id))) then return 'preset'; end if;
  if jsonb_typeof(v_b.policies -> 'preapproved') = 'array' and (v_b.policies -> 'preapproved') ? p_action
     and (v_b.preapproved_trusted or v_t.parent_task_id is not null) then
    return 'brief';
  end if;
  return null;
end $$;

create or replace function private.requires_approval(p_action text, p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.action_allowed(p_action, p_task_id) is null;
$$;

create or replace function public.create_agent_task(p_row_page_id text, p_brief jsonb, p_delegate_agent_id uuid default null,
  p_parent_task_id uuid default null, p_reference_task_ids uuid[] default '{}', p_depends_on_task_ids uuid[] default '{}',
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_page public.pages%rowtype; v_parent public.agent_tasks%rowtype;
        v_agent uuid; v_a public.agents%rowtype; v_d public.agents%rowtype; v_owner uuid; v_author uuid; v_author_type text;
        v_id uuid := gen_random_uuid(); v_ctx uuid; v_db text; v_receipt jsonb; v_spent numeric;
begin
  if v_uid is null then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope = 'create_agent_task' and key = p_idempotency_key and actor_id = v_uid;
    if found then return v_receipt; end if;
  end if;
  perform private.validate_brief(p_brief);

  select * into v_page from public.pages where id = p_row_page_id and deleted_at is null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if p_parent_task_id is not null then
    select * into v_parent from public.agent_tasks where id = p_parent_task_id;
    if not found then raise exception using errcode = 'PT404', message = 'parent_not_found'; end if;
    if v_parent.workspace_id <> v_page.workspace_id then raise exception using errcode = 'PT422', message = 'cross_workspace'; end if;
  end if;

  if private.is_agent() then
    -- Lead agents create subtasks under their own task, or top-level tasks for their sponsor (create_task tool).
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    select * into v_a from public.agents where id = v_agent;
    if v_a.role <> 'lead' then raise exception using errcode = 'PT403', message = 'lead_only'; end if;
    if p_parent_task_id is not null and v_parent.delegate_agent_id is distinct from v_agent then
      raise exception using errcode = 'PT403', message = 'lead_only';
    end if;
    if v_a.workspace_id <> v_page.workspace_id or not private.agent_can(p_row_page_id, 'write') then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_owner := v_a.sponsor_user_id; v_author := v_agent; v_author_type := 'agent';
  else
    if not private.can_write_page(p_row_page_id, v_page.workspace_id) then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_owner := v_uid; v_author := v_uid; v_author_type := 'human';
  end if;

  if p_delegate_agent_id is not null then
    select * into v_d from public.agents
     where id = p_delegate_agent_id and workspace_id = v_page.workspace_id and status = 'enabled' and revoked_at is null;
    if not found then raise exception using errcode = 'PT404', message = 'delegate_not_found'; end if;
    if v_d.monthly_budget_usd is not null then
      select coalesce(sum(cost_usd), 0) into v_spent from public.agent_runs
       where agent_id = v_d.id and started_at >= date_trunc('month', now());
      if v_spent > v_d.monthly_budget_usd then
        raise exception using errcode = 'PT402', message = 'budget_exceeded',
          detail = jsonb_build_object('spent_usd', v_spent, 'budget_usd', v_d.monthly_budget_usd)::text;
      end if;
    end if;
  end if;

  if exists (select 1 from public.agent_tasks where row_page_id = p_row_page_id and state not in ('done','failed','cancelled')) then
    raise exception using errcode = 'PT409', message = 'task_exists';
  end if;

  v_ctx := coalesce(v_parent.context_id, v_id);
  if exists (select 1 from unnest(coalesce(p_depends_on_task_ids, '{}')) d
              where not exists (select 1 from public.agent_tasks x where x.id = d and x.context_id = v_ctx)) then
    raise exception using errcode = 'PT422', message = 'invalid_dependency';
  end if;
  select p.id into v_db from public.pages p where p.id = v_page.parent_id and p.data ? 'database';

  insert into public.agent_tasks (id, workspace_id, context_id, db_page_id, row_page_id, title, delegate_agent_id, owner_user_id,
                                  parent_task_id, reference_task_ids, depends_on_task_ids, brief_version, created_by, created_by_type)
  values (v_id, v_page.workspace_id, v_ctx, v_db, p_row_page_id, coalesce(v_page.data->>'title', ''), p_delegate_agent_id, v_owner,
          p_parent_task_id, coalesce(p_reference_task_ids, '{}'), coalesce(p_depends_on_task_ids, '{}'), 1, v_author, v_author_type);

  -- A preapproval counts only when a person writes it from the app itself.
  insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, decisions, sources,
                                  open_questions, next_step, policies, author_id, author_type, preapproved_trusted)
  values (v_id, 1, v_page.workspace_id, p_brief->>'objective', coalesce(p_brief->>'constraints', ''),
          coalesce(p_brief->'done_when', '[]'), coalesce(p_brief->'decisions', '[]'), coalesce(p_brief->'sources', '[]'),
          coalesce(p_brief->'open_questions', '[]'), coalesce(p_brief->>'next_step', ''), coalesce(p_brief->'policies', '{}'),
          v_author, v_author_type, v_author_type = 'human' and private.jwt_client_id() is null);

  perform private.ensure_delegate_grants(p_delegate_agent_id, v_page.workspace_id, p_row_page_id, p_brief->'sources');

  insert into public.agent_activities (workspace_id, task_id, seq, type, body, author_type, author_id)
  values (v_page.workspace_id, v_id, private.next_seq(v_id), 'prompt',
          jsonb_build_object('text', p_brief->>'objective', 'signal', 'start',
                             'source', case when v_author_type = 'agent' then 'lead' else 'button' end),
          v_author_type, v_author);

  if p_delegate_agent_id is not null and coalesce((v_d.capabilities->>'start')::boolean, false)
     and not exists (select 1 from unnest(coalesce(p_depends_on_task_ids, '{}')) d
                      join public.agent_tasks x on x.id = d where x.state <> 'done') then
    insert into public.agent_events (workspace_id, task_id, agent_id, type, payload, seq)
    values (v_page.workspace_id, v_id, p_delegate_agent_id, 'task.start',
            jsonb_build_object('context_id', v_ctx, 'brief_version', 1), private.next_event_seq(v_id));
  end if;

  perform private.audit(v_page.workspace_id, 'task.create', jsonb_build_object('task_id', v_id, 'row_page_id', p_row_page_id,
                                                                              'delegate_agent_id', p_delegate_agent_id));
  v_receipt := jsonb_build_object('task_id', v_id, 'context_id', v_ctx, 'brief_version', 1);
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('create_agent_task', p_idempotency_key, v_uid, v_receipt);
  end if;
  return v_receipt;
end $$;

create or replace function public.update_brief(p_task_id uuid, p_patch jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_agent uuid; v_full boolean := false;
        v_author uuid; v_author_type text; v_bad text; v_new jsonb; v_ver int; v_d public.agents%rowtype; v_trusted boolean;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    if exists (select 1 from public.agent_tasks p join public.agents a on a.id = p.delegate_agent_id
                where p.id = v_t.parent_task_id and p.delegate_agent_id = v_agent and a.role = 'lead') then
      v_full := true;
    elsif v_t.delegate_agent_id = v_agent then
      v_full := false;
    else
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_author := v_agent; v_author_type := 'agent';
  else
    if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_full := true; v_author := (select auth.uid()); v_author_type := 'human';
  end if;

  select key into v_bad from jsonb_object_keys(p_patch) key
   where not key = any (case when v_full
                     then array['objective','constraints','done_when','decisions','sources','open_questions','next_step','policies',
                                'delegate_agent_id','depends_on_task_ids']
                     else array['decisions','open_questions','next_step'] end) limit 1;
  if v_bad is not null then raise exception using errcode = 'PT422', message = 'field_not_allowed', detail = v_bad; end if;

  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  -- A chat session acts for a person but never unlocks an action: what the brief allows or asks for is set from the app.
  if v_author_type = 'human' and private.jwt_client_id() is not null and p_patch ? 'policies'
     and (p_patch -> 'policies') is distinct from v_b.policies then
    raise exception using errcode = 'PT403', message = 'direct_session_required';
  end if;
  v_new := (to_jsonb(v_b) - 'task_id' - 'version' - 'workspace_id' - 'author_id' - 'author_type' - 'created_at' - 'preapproved_trusted')
           || (p_patch - 'delegate_agent_id' - 'depends_on_task_ids');
  perform private.validate_brief(v_new);

  if p_patch ? 'delegate_agent_id' and (p_patch->>'delegate_agent_id') is not null then
    select * into v_d from public.agents
     where id = (p_patch->>'delegate_agent_id')::uuid and workspace_id = v_t.workspace_id and status = 'enabled' and revoked_at is null;
    if not found then raise exception using errcode = 'PT404', message = 'delegate_not_found'; end if;
  end if;
  if p_patch ? 'depends_on_task_ids' and exists (
       select 1 from jsonb_array_elements_text(p_patch->'depends_on_task_ids') d
        where not exists (select 1 from public.agent_tasks x where x.id = d::uuid and x.context_id = v_t.context_id and x.id <> v_t.id)) then
    raise exception using errcode = 'PT422', message = 'invalid_dependency';
  end if;

  v_ver := v_t.brief_version + 1;
  -- The preapproved list keeps its trust while it does not change; a new list is trusted only when a person writes it
  -- from the app itself.
  v_trusted := case
    when (coalesce(v_new->'policies', '{}'::jsonb) -> 'preapproved') is not distinct from (v_b.policies -> 'preapproved')
      then v_b.preapproved_trusted
    else v_author_type = 'human' and private.jwt_client_id() is null end;
  insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, decisions, sources,
                                  open_questions, next_step, policies, author_id, author_type, preapproved_trusted)
  values (v_t.id, v_ver, v_t.workspace_id, v_new->>'objective', coalesce(v_new->>'constraints', ''),
          coalesce(v_new->'done_when', '[]'), coalesce(v_new->'decisions', '[]'), coalesce(v_new->'sources', '[]'),
          coalesce(v_new->'open_questions', '[]'), coalesce(v_new->>'next_step', ''), coalesce(v_new->'policies', '{}'),
          v_author, v_author_type, v_trusted);

  update public.agent_tasks
     set brief_version = v_ver,
         delegate_agent_id = case when p_patch ? 'delegate_agent_id' then (p_patch->>'delegate_agent_id')::uuid else delegate_agent_id end,
         depends_on_task_ids = case when p_patch ? 'depends_on_task_ids'
                                    then array(select d::uuid from jsonb_array_elements_text(p_patch->'depends_on_task_ids') d)
                                    else depends_on_task_ids end,
         updated_at = now()
   where id = v_t.id;

  if p_patch ? 'delegate_agent_id' and v_d.id is not null then
    perform private.ensure_delegate_grants(v_d.id, v_t.workspace_id, v_t.row_page_id, v_new->'sources');
  end if;
  perform private.audit(v_t.workspace_id, 'brief.update', jsonb_build_object('task_id', v_t.id, 'version', v_ver));
  return v_ver;
end $$;

-- An approval granted by the autonomy level or the brief, recorded like one a person gives: approval row, activity, audit.
-- From request_approval it is decided with a 15 minute receipt (the same one if asked again); from begin_external_op, consumed.
-- A request for the same action still waiting on a person is settled by it: cancelled, and the run and the task resume
-- when nothing else blocks.
create or replace function private.record_auto_approval(p_run public.agent_runs, p_action text, p_params jsonb,
  p_artifact_id uuid, p_by text, p_consumed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_ver int; v_hash text; v_a public.agent_approvals%rowtype; v_level text;
begin
  select * into v_t from public.agent_tasks where id = p_run.task_id for update;
  if p_artifact_id is not null then
    select version into v_ver from public.agent_artifacts where id = p_artifact_id and task_id = v_t.id;
    if not found then raise exception using errcode = 'PT404', message = 'artifact_not_found'; end if;
  end if;
  v_hash := private.action_hash(p_action, v_t.id, v_ver, p_params);
  v_level := private.task_autonomy_level(v_t.id);
  update public.agent_approvals set status = 'cancelled'
   where task_id = v_t.id and kind = 'action' and status = 'pending' and action_hash = v_hash;
  if found and not private.task_waits_on_human(v_t.id) then
    update public.agent_runs set status = 'running' where id = p_run.id and status = 'waiting';
    update public.agent_tasks set state = 'working', waiting_on = null, updated_at = now()
     where id = v_t.id and state = 'input_required' and active_run_id = p_run.id;
  end if;
  if not p_consumed then
    select * into v_a from public.agent_approvals
     where task_id = v_t.id and auto_by is not null and status = 'decided' and action_hash = v_hash and receipt_expires_at > now()
     order by decided_at desc limit 1;
    if found then
      return jsonb_build_object('approval_id', v_a.id, 'action_hash', v_hash, 'status', 'approved', 'receipt', v_a.receipt,
                                'receipt_expires_at', v_a.receipt_expires_at,
                                'auto_approved', jsonb_build_object('by', v_a.auto_by, 'level', v_level));
    end if;
  end if;
  insert into public.agent_approvals (workspace_id, task_id, run_id, kind, action, action_hash, params, artifact_id, artifact_version,
                                      question, options, status, decision, response, receipt, receipt_expires_at,
                                      consumed_at, consumed_by_op, requested_by_type, requested_by_id, decided_by, decided_at, auto_by)
  values (v_t.workspace_id, v_t.id, p_run.id, 'action', p_action, v_hash, p_params, p_artifact_id, v_ver,
          '', array['approve'], case when p_consumed then 'consumed' else 'decided' end, 'approve',
          jsonb_build_object('auto', true, 'by', p_by, 'level', v_level),
          case when p_consumed then null else gen_random_uuid() end,
          case when p_consumed then null else now() + interval '15 minutes' end,
          case when p_consumed then now() end, case when p_consumed then 'begin_external_op' end,
          'system', p_run.agent_id, null, now(), p_by)
  returning * into v_a;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, p_run.id, private.next_seq(v_t.id), 'action',
          jsonb_build_object('op', 'auto_approval', 'approval_id', v_a.id, 'action', p_action, 'by', p_by, 'level', v_level,
                             'summary', 'Approved automatically: ' || p_action
                                        || case p_by when 'preset' then ' (autonomy ' || v_level || ')' else ' (preapproved in the brief)' end),
          'system', p_run.agent_id);
  insert into public.audit_events (workspace_id, actor_id, actor_type, run_id, action, target)
  values (v_t.workspace_id, null, 'system', p_run.id, 'approval.auto',
          jsonb_build_object('approval_id', v_a.id, 'task_id', v_t.id, 'action', p_action, 'by', p_by, 'level', v_level));
  return jsonb_build_object('approval_id', v_a.id, 'action_hash', v_hash, 'status', 'approved', 'receipt', v_a.receipt,
                            'receipt_expires_at', v_a.receipt_expires_at, 'auto_approved', jsonb_build_object('by', p_by, 'level', v_level));
end $$;

create or replace function public.request_approval(p_run_id uuid, p_action text, p_params jsonb, p_artifact_id uuid default null,
  p_question text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_res jsonb; v_by text;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_action, '') = '' or jsonb_typeof(coalesce(p_params, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  v_by := private.action_allowed(p_action, v_r.task_id);
  if v_by is not null then
    return private.record_auto_approval(v_r, p_action, coalesce(p_params, '{}'::jsonb), p_artifact_id, v_by, false);
  end if;
  v_res := private.request_approval_core(v_r, p_action, p_params, p_artifact_id, p_question);
  return jsonb_build_object('approval_id', v_res->'approval_id', 'action_hash', v_res->'action_hash', 'status', 'pending');
end $$;

create or replace function public.begin_external_op(p_run_id uuid, p_provider text, p_action text, p_params jsonb,
  p_approval_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_hash text; v_op public.external_ops%rowtype; v_approval uuid; v_auto uuid; v_ver int; v_res jsonb;
        v_by text; v_receipt uuid := p_approval_receipt;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_provider, '') = '' or coalesce(p_action, '') = '' or jsonb_typeof(p_params) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_provider || '|' || p_action || '|' || p_params::text, 'utf8'), 'sha256'), 'hex');
  select * into v_op from public.external_ops
   where run_id = v_r.id and params_hash = v_hash and status in ('pending','unknown') order by created_at limit 1;
  if found then
    return jsonb_build_object('op_id', v_op.op_id, 'idempotency_key', v_op.idempotency_key, 'status', v_op.status);
  end if;

  v_by := private.action_allowed(p_action, v_r.task_id);
  if v_by is null then
    -- The action asks a person. An approval the level granted earlier no longer counts: the level stopped allowing it.
    if v_receipt is not null and exists (select 1 from public.agent_approvals where receipt = v_receipt and auto_by is not null) then
      v_receipt := null;
    end if;
    if v_receipt is null then
      select receipt into v_auto from public.agent_approvals
       where task_id = v_r.task_id and kind = 'action' and status = 'decided' and decision in ('approve','edit') and auto_by is null
         and receipt is not null and receipt_expires_at > now() and action_hash = private.action_hash(p_action, v_r.task_id, null, p_params)
       order by decided_at desc limit 1;
      if v_auto is null then
        v_res := private.request_approval_core(v_r, p_action, p_params, null, 'Approve ' || p_action || ' via ' || p_provider || '?');
        return jsonb_build_object('status', 'approval_required', 'approval_id', v_res->'approval_id');
      end if;
      v_approval := private.consume_approval(v_auto, p_action, p_params, null, 'begin_external_op');
    else
      select artifact_version into v_ver from public.agent_approvals where receipt = v_receipt;
      v_approval := private.consume_approval(v_receipt, p_action, p_params, v_ver, 'begin_external_op');
    end if;
  else
    -- Allowed without asking. A receipt passed in is checked like any other; without one, consume an approval already
    -- granted for this action (request_approval) or record an automatic one, consumed here.
    if v_receipt is not null then
      select artifact_version into v_ver from public.agent_approvals where receipt = v_receipt;
      v_approval := private.consume_approval(v_receipt, p_action, p_params, v_ver, 'begin_external_op');
    else
      select receipt into v_auto from public.agent_approvals
       where task_id = v_r.task_id and kind = 'action' and status = 'decided' and decision in ('approve','edit')
         and receipt is not null and receipt_expires_at > now() and action_hash = private.action_hash(p_action, v_r.task_id, null, p_params)
       order by decided_at desc limit 1;
      if v_auto is not null then
        v_approval := private.consume_approval(v_auto, p_action, p_params, null, 'begin_external_op');
      else
        v_approval := (private.record_auto_approval(v_r, p_action, p_params, null, v_by, true) ->> 'approval_id')::uuid;
      end if;
    end if;
  end if;

  insert into public.external_ops (workspace_id, task_id, run_id, provider, action, params_hash, params, idempotency_key, approval_id)
  values (v_r.workspace_id, v_r.task_id, v_r.id, p_provider, p_action, v_hash, p_params, gen_random_uuid()::text, v_approval)
  returning * into v_op;
  return jsonb_build_object('op_id', v_op.op_id, 'idempotency_key', v_op.idempotency_key, 'status', v_op.status);
end $$;

-- What a task may do without asking, for people (panel, card) and agents (get_task).
create or replace function public.task_autonomy(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_req text; v_own text; v_level text; v_auto text[];
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found or not private.can_read_task(p_task_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  select autonomy into v_req from public.agent_task_policies where task_id = v_t.id;
  v_own := private.own_autonomy_level(v_t.id);
  v_level := private.task_autonomy_level(v_t.id);
  select coalesce(array_agg(s.a order by s.a), '{}') into v_auto
    from (select distinct x as a
            from unnest(private.autonomy_preset('autonomous')
                        || coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_b.policies->'preapproved') = 'array'
                                                                                 then v_b.policies->'preapproved' else '[]'::jsonb end)), '{}')) x) s
   where private.action_allowed(s.a, v_t.id) is not null;
  return jsonb_build_object(
    'level', v_level, 'requested', v_req,
    'source', case when v_level <> v_own then 'parent' when v_req is not null and v_own = v_req then 'task' else 'workspace' end,
    'workspace_level', private.workspace_autonomy(v_t.workspace_id),
    'auto_approved', to_jsonb(v_auto),
    -- What the ? test of action_allowed matches, always as a list: one string, the strings of a list, the keys of an object.
    'require_approval', to_jsonb(case jsonb_typeof(v_b.policies->'require_approval')
      when 'string' then array[v_b.policies->>'require_approval']
      when 'array' then array(select e #>> '{}' from jsonb_array_elements(v_b.policies->'require_approval') e where jsonb_typeof(e) = 'string')
      when 'object' then array(select jsonb_object_keys(v_b.policies->'require_approval'))
      else array[]::text[] end),
    -- Whether set_task_autonomy would let the caller change the level: the workspace owner, from the app itself.
    'can_edit', private.is_workspace_owner(v_t.workspace_id) and private.jwt_client_id() is null);
end $$;

-- Only the workspace owner, from the app itself: raising a task unlocks actions a person would otherwise approve.
-- null clears the task's own level. Never touches the brief.
create or replace function public.set_task_autonomy(p_task_id uuid, p_level text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_old text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found or not private.can_read_task(p_task_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_owner(v_t.workspace_id) then raise exception using errcode = 'PT403', message = 'owner_required'; end if;
  if p_level is not null and p_level not in ('ask','balanced','autonomous') then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select autonomy into v_old from public.agent_task_policies where task_id = v_t.id;
  if p_level is null then
    delete from public.agent_task_policies where task_id = v_t.id;
  else
    insert into public.agent_task_policies (task_id, autonomy, set_by, set_at) values (v_t.id, p_level, (select auth.uid()), now())
    on conflict (task_id) do update set autonomy = excluded.autonomy, set_by = excluded.set_by, set_at = excluded.set_at;
  end if;
  perform private.audit(v_t.workspace_id, 'autonomy.task_set', jsonb_build_object('task_id', v_t.id, 'from', v_old, 'to', p_level));
  return public.task_autonomy(v_t.id);
end $$;

create or replace function public.get_autonomy_policy(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_p public.agent_workspace_policies%rowtype;
begin
  if not private.is_human_member(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  select * into v_p from public.agent_workspace_policies where workspace_id = p_workspace_id;
  return jsonb_build_object('level', coalesce(v_p.autonomy, 'ask'), 'updated_at', v_p.updated_at, 'updated_by', v_p.updated_by,
    'can_edit', private.is_workspace_owner(p_workspace_id) and private.jwt_client_id() is null,
    'presets', jsonb_build_object('ask', to_jsonb(private.autonomy_preset('ask')), 'balanced', to_jsonb(private.autonomy_preset('balanced')),
                                  'autonomous', to_jsonb(private.autonomy_preset('autonomous'))));
end $$;

-- Only the workspace owner, from the app itself: raising the level unlocks actions a person would otherwise approve.
create or replace function public.set_workspace_autonomy(p_workspace_id uuid, p_level text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if not private.is_workspace_owner(p_workspace_id) then raise exception using errcode = 'PT403', message = 'owner_required'; end if;
  if p_level is null or p_level not in ('ask','balanced','autonomous') then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  v_old := private.workspace_autonomy(p_workspace_id);
  insert into public.agent_workspace_policies (workspace_id, autonomy, updated_by, updated_at)
  values (p_workspace_id, p_level, (select auth.uid()), now())
  on conflict (workspace_id) do update set autonomy = excluded.autonomy, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.audit(p_workspace_id, 'autonomy.set', jsonb_build_object('from', v_old, 'to', p_level));
  return jsonb_build_object('level', p_level, 'previous', v_old);
end $$;

revoke execute on function private.autonomy_preset(text) from public;
revoke execute on function private.autonomy_rank(text) from public;
revoke execute on function private.autonomy_min(text, text) from public;
revoke execute on function private.is_owner_user(uuid, uuid) from public;
revoke execute on function private.workspace_autonomy(uuid) from public;
revoke execute on function private.own_autonomy_level(uuid) from public;
revoke execute on function private.task_autonomy_level(uuid, int) from public;
revoke execute on function private.action_allowed(text, uuid, int) from public;
revoke execute on function private.record_auto_approval(public.agent_runs, text, jsonb, uuid, text, boolean) from public;
revoke all on function public.task_autonomy(uuid) from public, anon;
revoke all on function public.set_task_autonomy(uuid, text) from public, anon;
revoke all on function public.get_autonomy_policy(uuid) from public, anon;
revoke all on function public.set_workspace_autonomy(uuid, text) from public, anon;
grant execute on function public.task_autonomy(uuid) to authenticated;
grant execute on function public.set_task_autonomy(uuid, text) to authenticated;
grant execute on function public.get_autonomy_policy(uuid) to authenticated;
grant execute on function public.set_workspace_autonomy(uuid, text) to authenticated;
