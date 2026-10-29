-- 0014 · task.updated: the parent's delegate learns that a subtask closed.
--
-- close_task (0011) leaves a prompt on the parent but no event; close_subtask (0009) leaves nothing on the
-- parent. A Lead waiting on the parent (wait_for_task, the bridge channel, a webhook) had to poll. Both
-- functions now queue one agent_events row of the new type task.updated to the parent's delegate.

alter table public.agent_events drop constraint agent_events_type_check;
alter table public.agent_events add constraint agent_events_type_check
  check (type in ('task.start','task.continue','task.feedback','task.stop','approval.decided','brief.updated','task.updated'));

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
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select p.workspace_id, p.id, p.active_run_id, p.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', p_acceptance, 'closed_by', 'human'),
         private.next_event_seq(p.id)
    from public.agent_tasks p
   where p.id = v_t.parent_task_id and p.delegate_agent_id is not null;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close', jsonb_build_object('task_id', v_t.id, 'acceptance', p_acceptance));
  return jsonb_build_object('task_state', 'done', 'acceptance', p_acceptance);
end $$;

create or replace function public.close_subtask(p_task_id uuid, p_verdict text default 'accepted', p_evidence jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_t public.agent_tasks%rowtype; v_parent public.agent_tasks%rowtype; v_policies jsonb; v_ok boolean;
begin
  v_agent := private.current_agent_id();
  if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
  perform private.check_rate(v_agent);
  if coalesce(p_verdict, '') <> 'accepted' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id and parent_task_id is not null for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select p.* into v_parent from public.agent_tasks p where p.id = v_t.parent_task_id;
  select b.policies into v_policies from public.task_briefs b where b.task_id = v_parent.id and b.version = v_parent.brief_version;
  if v_parent.delegate_agent_id is distinct from v_agent
     or not exists (select 1 from public.agents where id = v_agent and role = 'lead') then
    raise exception using errcode = 'PT403', message = 'lead_only';
  end if;
  if v_t.state <> 'ready_for_review' then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  v_ok := coalesce(v_policies->>'subtask_close', '') = 'lead' or private.deterministic_checks_pass(v_t.id);
  if not v_ok then raise exception using errcode = 'PT422', message = 'policy_denied'; end if;

  update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
         waiting_on = null, updated_at = now()
   where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text', 'Closed by the lead.', 'verdict', p_verdict, 'evidence', coalesce(p_evidence, '[]'::jsonb),
                             'rule', case when coalesce(v_policies->>'subtask_close', '') = 'lead' then 'policy' else 'deterministic' end),
          'agent', v_agent);
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_parent.workspace_id, v_parent.id, v_parent.active_run_id, v_parent.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', 'lead'),
         private.next_event_seq(v_parent.id)
   where v_parent.delegate_agent_id is not null;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close_subtask', jsonb_build_object('task_id', v_t.id));
  return jsonb_build_object('task_state', 'done');
end $$;

revoke all on function public.close_task(uuid, text, text) from public, anon;
grant execute on function public.close_task(uuid, text, text) to authenticated;
revoke all on function public.close_subtask(uuid, text, jsonb) from public, anon;
grant execute on function public.close_subtask(uuid, text, jsonb) to authenticated;
