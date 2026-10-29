-- 0018_reviewer_agent: a reviewer agent reviews a subtask from its own run on a "review task": a subtask of the
-- SAME parent (so only that parent's Lead can delegate it) whose brief policy review_of names the subtask. The review closes the review task; the run stays
-- active so the reviewer may still close the subtask by the parent's policy or a deterministic check.

create or replace function private.reviewer_run_of(p_subtask_id uuid, p_run_id uuid default null)
returns uuid language sql stable security definer set search_path = '' as $$
  select r.id
    from public.agent_tasks s
    join public.agent_tasks rt on rt.workspace_id = s.workspace_id and rt.parent_task_id = s.parent_task_id
                                 and rt.delegate_agent_id = private.current_agent_id()
    join public.task_briefs b on b.task_id = rt.id and b.version = rt.brief_version
    join public.agent_runs r on r.task_id = rt.id and r.agent_id = private.current_agent_id() and r.status in ('running','waiting')
   where s.id = p_subtask_id
     and b.policies->>'review_of' = s.id::text
     and (p_run_id is null or r.id = p_run_id)
   order by r.started_at desc
   limit 1;
$$;
revoke execute on function private.reviewer_run_of(uuid, uuid) from public;

create or replace function public.review_task(p_task_id uuid, p_verdict text, p_findings jsonb default '[]'::jsonb,
  p_evidence jsonb default '[]'::jsonb, p_artifact_id uuid default null, p_run_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_art public.agent_artifacts%rowtype; v_agent uuid; v_run uuid;
        v_reviewer uuid; v_reviewer_type text; v_bad text; v_id uuid; v_rounds int; v_state text; v_text text;
        v_review_run uuid; v_review_task uuid;
begin
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    v_run := coalesce(p_run_id, private.current_run_id());
    v_review_run := private.reviewer_run_of(v_t.id, v_run);
    if v_review_run is not null then
      v_run := v_review_run;
      select task_id into v_review_task from public.agent_runs where id = v_review_run;
    elsif private.lead_of(v_t.parent_task_id) is null or v_run is null or not exists (
         select 1 from public.agent_runs r where r.id = v_run and r.agent_id = v_agent and r.task_id = v_t.parent_task_id
            and r.status in ('running','waiting')) then
      raise exception using errcode = 'PT403', message = 'forbidden', detail = 'review from your own run on the parent task, or from your run on the review task';
    end if;
    v_reviewer := v_agent; v_reviewer_type := 'agent';
  else
    if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_reviewer := (select auth.uid()); v_reviewer_type := 'human';
  end if;

  if p_verdict is null or p_verdict not in ('approved','changes_requested','blocked')
     or jsonb_typeof(coalesce(p_findings, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  if v_t.state <> 'ready_for_review' then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  select f->>'criterion_id' into v_bad from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
   where not exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
                      where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'id' = f->>'criterion_id') limit 1;
  if v_bad is not null or exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f where f->>'criterion_id' is null) then
    raise exception using errcode = 'PT422', message = 'unknown_criterion', detail = coalesce(v_bad, '');
  end if;
  if p_artifact_id is not null then
    select * into v_art from public.agent_artifacts where id = p_artifact_id and task_id = v_t.id;
  else
    select * into v_art from public.agent_artifacts where task_id = v_t.id and superseded_by is null order by created_at desc limit 1;
  end if;
  if v_art.id is null then raise exception using errcode = 'PT422', message = 'artifact_required'; end if;

  insert into public.agent_reviews (workspace_id, task_id, run_id, reviewer_type, reviewer_id, artifact_id, artifact_version,
                                    brief_version, verdict, findings, evidence)
  values (v_t.workspace_id, v_t.id, v_run, v_reviewer_type, v_reviewer, v_art.id, v_art.version, v_t.brief_version,
          p_verdict, coalesce(p_findings, '[]'::jsonb), coalesce(p_evidence, '[]'::jsonb))
  returning id into v_id;

  v_rounds := v_t.review_rounds;
  v_state := v_t.state;
  if p_verdict = 'changes_requested' then
    v_rounds := v_rounds + 1;
    if v_rounds > v_t.max_review_rounds then
      v_state := 'input_required';
      update public.agent_tasks set review_state = p_verdict, review_rounds = v_rounds, state = v_state, waiting_on = 'human',
             updated_at = now() where id = v_t.id;
      insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
      values (v_t.workspace_id, v_t.owner_user_id, 'escalation', v_t.row_page_id, v_t.id, v_reviewer, v_reviewer_type,
              jsonb_build_object('rounds', v_rounds, 'review_id', v_id));
    else
      v_state := case when v_t.active_run_id is not null then 'working' else 'queued' end;
      update public.agent_tasks set review_state = p_verdict, review_rounds = v_rounds, state = v_state, waiting_on = null,
             updated_at = now() where id = v_t.id;
      select string_agg(coalesce(f->>'criterion_id', '') || ' ' || coalesce(f->>'status', '') || ': ' || coalesce(f->>'note', ''), E'\n')
        into v_text from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f;
      insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
      values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'prompt',
              jsonb_build_object('text', coalesce(v_text, 'Changes requested.'), 'signal', 'feedback',
                                 'source', case when v_review_run is not null then 'reviewer' when v_reviewer_type = 'agent' then 'lead' else 'row_panel' end, 'review_id', v_id),
              v_reviewer_type, v_reviewer);
      if v_t.delegate_agent_id is not null then
        insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
        values (v_t.workspace_id, v_t.id, null, v_t.delegate_agent_id, 'task.feedback',
                jsonb_build_object('text', coalesce(v_text, 'Changes requested.'), 'review_id', v_id, 'round', v_rounds),
                private.next_event_seq(v_t.id));
      end if;
    end if;
  elsif p_verdict = 'blocked' then
    v_state := 'input_required';
    update public.agent_tasks set review_state = p_verdict, state = v_state, waiting_on = 'human', updated_at = now() where id = v_t.id;
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
    values (v_t.workspace_id, v_t.owner_user_id, 'input_required', v_t.row_page_id, v_t.id, v_reviewer, v_reviewer_type,
            jsonb_build_object('review_id', v_id, 'blocked', true));
  else
    update public.agent_tasks set review_state = p_verdict, updated_at = now() where id = v_t.id;
  end if;

  if v_review_task is not null then
    -- The review is the deliverable of the review task: close it; the run stays active (end_run leaves done tasks alone, 0006:941-942).
    update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
           waiting_on = null, updated_at = now()
     where id = v_review_task;
    insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
    values (v_t.workspace_id, v_review_task, v_review_run, private.next_seq(v_review_task), 'response',
            jsonb_build_object('text', 'Review recorded: ' || p_verdict, 'review_id', v_id, 'review_of', v_t.id, 'verdict', p_verdict, 'submit', true),
            'agent', v_agent);
    -- The Lead waiting on the parent learns at once that the review task closed (0014 wakes waits from agent_events).
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    select p.workspace_id, p.id, p.active_run_id, p.delegate_agent_id, 'task.updated',
           jsonb_build_object('subtask_id', v_review_task, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', 'reviewer',
                              'review_of', v_t.id, 'review_id', v_id, 'verdict', p_verdict),
           private.next_event_seq(p.id)
      from public.agent_tasks p
     where p.id = v_t.parent_task_id and p.delegate_agent_id is not null;
    perform private.release_dependents(v_review_task);
  end if;

  perform private.audit(v_t.workspace_id, 'review.add', jsonb_build_object('task_id', v_t.id, 'review_id', v_id, 'verdict', p_verdict));
  return jsonb_build_object('review_id', v_id, 'task_state', v_state, 'rounds', v_rounds);
end $$;
revoke all on function public.review_task(uuid, text, jsonb, jsonb, uuid, uuid) from public, anon;
grant execute on function public.review_task(uuid, text, jsonb, jsonb, uuid, uuid) to authenticated;

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
  if v_t.state <> 'ready_for_review' then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  v_ok := coalesce(v_policies->>'subtask_close', '') = 'lead' or private.deterministic_checks_pass(v_t.id);
  if not v_ok then raise exception using errcode = 'PT422', message = 'policy_denied'; end if;

  update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
         waiting_on = null, updated_at = now()
   where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text', case when v_review_run is not null then 'Closed by the reviewer.' else 'Closed by the lead.' end, 'verdict', p_verdict, 'evidence', coalesce(p_evidence, '[]'::jsonb),
                             'rule', case when coalesce(v_policies->>'subtask_close', '') = 'lead' then 'policy' else 'deterministic' end),
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
revoke all on function public.close_subtask(uuid, text, jsonb) from public, anon;
grant execute on function public.close_subtask(uuid, text, jsonb) to authenticated;

-- submit_for_review (0006) trusted the run alone: a run that is still active after its task closed (the reviewer's run after
-- review_task, 0018 above) could reopen a done task as ready_for_review. The task must be working under this very run.
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
-- Same grants as 0006: nothing for public or anon, execute for authenticated.
revoke all on function public.submit_for_review(uuid, text, uuid[]) from public, anon;
grant execute on function public.submit_for_review(uuid, text, uuid[]) to authenticated;
