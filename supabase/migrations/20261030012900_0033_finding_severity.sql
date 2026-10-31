-- 0033_finding_severity: the cut rule as data. A finding is blocking (the default) or minor. Minor findings never count a
-- round, never send work back and never stop an approval; they reach the Lead, which opens a follow-up if it wants one.
-- A deterministic close still reads only verified findings on a criterion, so a minor one proves nothing.

-- Existing reviews have no provable session provenance, so cannot authorize conditional effects.
alter table public.agent_reviews add column direct_session boolean not null default false;

-- Full copy of review_task (0022).
create or replace function public.review_task(p_task_id uuid, p_verdict text, p_findings jsonb default '[]'::jsonb,
  p_evidence jsonb default '[]'::jsonb, p_artifact_id uuid default null, p_run_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_art public.agent_artifacts%rowtype; v_agent uuid; v_run uuid;
        v_reviewer uuid; v_reviewer_type text; v_bad text; v_id uuid; v_rounds int; v_state text; v_text text;
        v_review_run uuid; v_review_task uuid; v_minor jsonb;
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
            and r.status in ('running','waiting') and r.stop_requested_at is null
            and exists (select 1 from public.agent_tasks p where p.id=r.task_id and p.active_run_id=r.id)) then
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
  if exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
              where coalesce(f->>'severity', 'blocking') not in ('blocking','minor')) then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'severity is blocking or minor';
  end if;
  -- A blocking finding judges a criterion of the brief; a minor one can be about anything and only needs to say what.
  select f->>'criterion_id' into v_bad from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
   where coalesce(f->>'severity', 'blocking') = 'blocking'
     and not exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
                      where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'id' = f->>'criterion_id') limit 1;
  if v_bad is not null or exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
                                   where coalesce(f->>'severity', 'blocking') = 'blocking' and f->>'criterion_id' is null) then
    raise exception using errcode = 'PT422', message = 'unknown_criterion', detail = coalesce(v_bad, '');
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
              where f->>'severity' = 'minor' and coalesce(btrim(f->>'note'), '') = '') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'a minor finding says what it is in note';
  end if;
  -- Only blocking findings send work back or stop an approval.
  if p_verdict = 'changes_requested'
     and exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f where f->>'severity' = 'minor')
     and not exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
       where coalesce(f->>'severity', 'blocking') = 'blocking' and f->>'status' <> 'verified') then
    raise exception using errcode = 'PT422', message = 'no_blocking_findings';
  end if;
  if p_verdict = 'approved' and exists (select 1 from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
       where coalesce(f->>'severity', 'blocking') = 'blocking' and f->>'status' in ('not_found','contradicted')) then
    raise exception using errcode = 'PT422', message = 'blocking_findings_open';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('note', left(f->>'note', 1000), 'evidence_ref', f->>'evidence_ref')), '[]'::jsonb) into v_minor
    from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f where f->>'severity' = 'minor';
  if p_artifact_id is not null then
    select * into v_art from public.agent_artifacts where id = p_artifact_id and task_id = v_t.id;
  else
    select * into v_art from public.agent_artifacts where task_id = v_t.id and superseded_by is null order by created_at desc, id desc limit 1;
  end if;
  if v_art.id is null then raise exception using errcode = 'PT422', message = 'artifact_required'; end if;

  if v_art.author_type=v_reviewer_type and v_art.author_id=v_reviewer then
    raise exception using errcode='PT403',message='self_review';
  end if;

  insert into public.agent_reviews (workspace_id, task_id, run_id, reviewer_type, reviewer_id, artifact_id, artifact_version,
                                    brief_version, verdict, findings, evidence, direct_session)
  values (v_t.workspace_id, v_t.id, v_run, v_reviewer_type, v_reviewer, v_art.id, v_art.version, v_t.brief_version,
          p_verdict, coalesce(p_findings, '[]'::jsonb), coalesce(p_evidence, '[]'::jsonb), private.jwt_client_id() is null)
  returning id into v_id;

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
                              'review_of', v_t.id, 'review_id', v_id, 'verdict', p_verdict, 'minor_findings', v_minor),
           private.next_event_seq(p.id)
      from public.agent_tasks p
     where p.id = v_t.parent_task_id and p.delegate_agent_id is not null;
    perform private.release_dependents(v_review_task);
  end if;


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
        into v_text from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f where coalesce(f->>'severity', 'blocking') = 'blocking';
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
    update public.agent_tasks set review_state = 'none', state = v_state, waiting_on = 'human', updated_at = now() where id = v_t.id;
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
    values (v_t.workspace_id, v_t.owner_user_id, 'input_required', v_t.row_page_id, v_t.id, v_reviewer, v_reviewer_type,
            jsonb_build_object('review_id', v_id, 'blocked', true));
  else
    update public.agent_tasks set review_state = p_verdict, updated_at = now() where id = v_t.id;
  end if;


  perform private.audit(v_t.workspace_id, 'review.add', jsonb_build_object('task_id', v_t.id, 'review_id', v_id, 'verdict', p_verdict));
  return jsonb_build_object('review_id', v_id, 'task_state', v_state, 'rounds', v_rounds, 'minor_findings', v_minor);
end $$;

-- Full copy from 0030: minor notes are not evidence for deterministic or CI acceptance.
create or replace function private.deterministic_checks_pass(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' in ('deterministic','ci'))
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' in ('deterministic','ci')
         and not exists (
           select 1 from public.agent_reviews r, jsonb_array_elements(r.findings) f
            where r.task_id = t.id and r.outdated_by is null and r.direct_session
              and f->>'criterion_id' = c->>'id' and f->>'status' = 'verified'
              and coalesce(f->>'severity', 'blocking') = 'blocking'
              -- A new commit has a different ref, so it does not supersede the old artifact or its review.
              and (c->>'check' <> 'ci' or (r.brief_version = t.brief_version
                   and not exists (select 1 from public.agent_artifacts authored
                     where authored.id = r.artifact_id and authored.author_type = r.reviewer_type and authored.author_id = r.reviewer_id)
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
       where t.id = p_task_id and c->>'check' = 'ci' and private.ci_criterion(t, c)->>'state' <> 'passed');
$$;

create or replace function private.reviewer_run_of(p_subtask_id uuid, p_run_id uuid default null)
returns uuid language sql stable security definer set search_path = '' as $$
  select r.id
    from public.agent_tasks s
    join public.agent_tasks rt on rt.workspace_id = s.workspace_id and rt.parent_task_id = s.parent_task_id
                                 and rt.delegate_agent_id = private.current_agent_id()
    join public.task_briefs b on b.task_id = rt.id and b.version = rt.brief_version
    join public.agent_runs r on r.task_id = rt.id and r.agent_id = private.current_agent_id() and r.status in ('running','waiting')
   where s.id = p_subtask_id
     and rt.state not in ('done','cancelled') and rt.active_run_id=r.id and r.stop_requested_at is null
     and b.policies->>'review_of' = s.id::text
     and (p_run_id is null or r.id = p_run_id)
   order by r.started_at desc
   limit 1;
$$;
