-- A Lead closes what an agent other than its author approved, whoever created the page. A person's criterion still needs a person.
create or replace function private.lead_may_close(p_task_id uuid, p_parent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.task_autonomy_level(p_parent_id) = 'autonomous'
     and not exists (
       select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
              jsonb_array_elements(b.done_when) c
        where t.id = p_task_id and c->>'check' in ('human','deterministic','ci'))
     and exists (
       select 1 from public.agent_tasks t join public.agent_reviews r on r.task_id = t.id
        where t.id = p_task_id and t.review_state = 'approved' and r.reviewer_type = 'agent' and r.verdict = 'approved'
          and r.outdated_by is null and r.brief_version = t.brief_version
          and not exists (select 1 from public.agent_artifacts a
                           where a.task_id = t.id and a.author_type = 'agent' and a.author_id = r.reviewer_id))
$$;
revoke execute on function private.lead_may_close(uuid, uuid) from public, anon, authenticated;

create or replace function public.close_subtask(p_task_id uuid, p_verdict text default 'accepted', p_evidence jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_t public.agent_tasks%rowtype; v_parent public.agent_tasks%rowtype; v_policies jsonb; v_ok boolean; v_review_run uuid;
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
  -- CI always needs both keys, even when the parent normally lets the Lead close subtasks.
  if exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
              where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'check' = 'ci') then
    v_ok := private.deterministic_checks_pass(v_t.id, true);
  else
    v_ok := coalesce(v_policies->>'subtask_close', '') = 'lead' or private.deterministic_checks_pass(v_t.id, true)
          or private.lead_may_close(v_t.id, v_parent.id);
  end if;
  if not v_ok then raise exception using errcode = 'PT422', message = 'policy_denied'; end if;

  update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
         waiting_on = null, updated_at = now()
   where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text', case when v_review_run is not null then 'Closed by the reviewer.' else 'Closed by the lead.' end, 'verdict', p_verdict, 'evidence', coalesce(p_evidence, '[]'::jsonb),
                             'rule', case when coalesce(v_policies->>'subtask_close', '') = 'lead' then 'policy'
                                     when private.deterministic_checks_pass(v_t.id, true) then 'deterministic' else 'lead_review' end),
          'agent', v_agent);
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_parent.workspace_id, v_parent.id, v_parent.active_run_id, v_parent.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', case when v_review_run is not null then 'reviewer' else 'lead' end),
         private.next_event_seq(v_parent.id)
   where v_parent.delegate_agent_id is not null;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close_subtask', jsonb_build_object('task_id', v_t.id));
  return jsonb_build_object('task_state', 'done');
end $$;

create or replace function public.close_task(p_task_id uuid, p_acceptance text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_sub public.agent_tasks%rowtype; v_run public.agent_runs%rowtype; v_uid uuid := (select auth.uid());
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
