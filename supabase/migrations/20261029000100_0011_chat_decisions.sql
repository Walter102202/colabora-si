-- 0011 · Chat sessions may take decisions that execute nothing.
--
-- `direct_session_required` (0006) refused every decision from an OAuth chat session (a JWT with
-- client_id), as one factor that a person pressed the button in the workspace. That factor only
-- protects decisions that let an agent execute something irreversible: approving or editing an
-- action (kind = 'action', the receipt unlocks the external operation). Answering a question,
-- choosing an option on a plan or escalation, rejecting, and closing a task (Reopen exists) run
-- nothing on the outside world, so a chat may take them. The check moves after
-- `decision_not_offered`, so a chat session learns its decision was refused only once it is a
-- valid one.

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
  if p_decision in ('approve','edit') then v_receipt := gen_random_uuid(); end if;

  update public.agent_approvals
     set status='decided', decision=p_decision, response=p_response, decided_by=(select auth.uid()), decided_at=now(),
         params=v_params, action_hash=private.action_hash(action, task_id, artifact_version, v_params),
         receipt=v_receipt, receipt_expires_at = case when v_receipt is null then null else now() + interval '15 minutes' end
   where id = v_a.id;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_a.run_id, private.next_seq(v_t.id), 'prompt',
          jsonb_build_object('signal','feedback','source','row_panel','approval_id',v_a.id,'decision',p_decision,
                             'text', coalesce(p_response->>'text','')), 'human', (select auth.uid()));
  update public.agent_runs  set status='running' where id = v_a.run_id and status='waiting';
  update public.agent_tasks set state = case when active_run_id is not null then 'working' else 'queued' end, waiting_on=null
   where id = v_t.id and state='input_required';
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_t.workspace_id, v_t.id, v_a.run_id, v_t.delegate_agent_id, 'approval.decided',
         jsonb_build_object('approval_id',v_a.id,'decision',p_decision,'receipt',v_receipt,'receipt_expires_at',now()+interval '15 minutes'),
         private.next_event_seq(v_t.id)
   where v_t.delegate_agent_id is not null;
  insert into public.audit_events (workspace_id, actor_id, actor_type, action, target)
  values (v_t.workspace_id, (select auth.uid()), 'human', 'approval.decide', jsonb_build_object('approval_id',v_a.id,'decision',p_decision));
  return jsonb_build_object('status','decided','receipt',v_receipt,'receipt_expires_at', now()+interval '15 minutes');
end $$;

create or replace function public.close_task(p_task_id uuid, p_acceptance text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_run public.agent_runs%rowtype; v_uid uuid := (select auth.uid());
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
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close', jsonb_build_object('task_id', v_t.id, 'acceptance', p_acceptance));
  return jsonb_build_object('task_state', 'done', 'acceptance', p_acceptance);
end $$;

revoke all on function public.decide_approval(uuid, text, jsonb) from public, anon;
revoke all on function public.close_task(uuid, text, text) from public, anon;
grant execute on function public.decide_approval(uuid, text, jsonb) to authenticated;
grant execute on function public.close_task(uuid, text, text) to authenticated;
