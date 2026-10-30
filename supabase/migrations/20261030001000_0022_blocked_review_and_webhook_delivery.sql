-- 0022_blocked_review_and_webhook_delivery: fixes found after 0021.
-- Bodies replaced here are full copies of their latest definition; never edit an earlier migration.

-- ============ a blocked review waits on a person ============
-- review_task wrote review_state = 'blocked', which the check on agent_tasks.review_state (0004:23-24) does not allow, so
-- the verdict always failed. A blocked review ends the review without a verdict on the deliverable: the task waits on a
-- person (input_required) and review_state goes back to 'none'; the verdict stays on the agent_reviews row.
-- Full copy of review_task (0018); only the blocked branch changes.
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
    update public.agent_tasks set review_state = 'none', state = v_state, waiting_on = 'human', updated_at = now() where id = v_t.id;
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

-- ============ webhook agents are pushed to ============
-- agents.delivery defaults to 'pull' (0002:13) and nothing set 'push', so agent-dispatch acked every event of a webhook
-- agent as pulled and never posted it. Delivery now follows the connection: an agent with a webhook_url is pushed to,
-- every other agent pulls. The kind does not decide it: Settings creates the reference agent, which pulls with
-- wait_for_my_tasks, with kind 'webhook' and no webhook_url.
create or replace function private.delivery_for(p_connection jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_connection->'webhook_url') = 'string' and p_connection->>'webhook_url' <> '' then 'push' else 'pull' end;
$$;

create or replace function private.agents_derive_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.delivery := private.delivery_for(new.connection);
  return new;
end $$;
create trigger agents_10_delivery before insert or update of connection, delivery on public.agents
  for each row execute function private.agents_derive_delivery();

revoke execute on function private.delivery_for(jsonb) from public;
revoke execute on function private.agents_derive_delivery() from public;

-- Agents created before this migration with a webhook_url still say 'pull'.
update public.agents set delivery = private.delivery_for(connection) where delivery <> private.delivery_for(connection);

-- ============ a session does not resume a task that waits on a person ============
-- claim_task (0019) took any input_required task, so a session woken for a blocked or escalated review claimed it and
-- went back to work without the person's decision. hand_over, release_for_handover and a recoverable error (0019:202-203,
-- 0019:246-247, 0020:43-44) leave a task input_required without a run only while a blocking question is pending
-- (private.task_waits_on_human), and set waiting_on = 'human' in that case too, so waiting_on cannot tell the two apart.
-- An input_required task without a run is therefore claimed only while a blocking question is pending: a handed-over
-- task is still claimed and waits on its questions in the new run, while a blocked or escalated review waits for the
-- person's message (send_agent_message requeues it). Answering the last blocking question requeues a task without a run
-- (decide_approval, 0020), so it is claimed as queued. Full copy of claim_task (0019); only the task lookup changes.
create or replace function public.claim_task(p_task_id uuid default null, p_harness text default 'custom',
  p_external_session_id text default null, p_brief_version int default null, p_resume boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_task public.agent_tasks%rowtype; v_run uuid; v_brief jsonb; v_ver int; v_resume jsonb;
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
   order by t.created_at
   for update skip locked limit 1;
  if not found then
    if p_task_id is null then return jsonb_build_object('task_id', null); end if;
    if exists (select 1 from public.agent_tasks t where t.id = p_task_id and t.delegate_agent_id = v_agent
                and t.state = 'input_required' and t.active_run_id is null) then
      raise exception using errcode='PT409', message='task_unavailable', detail='the task waits on a person: claim it after they answer';
    end if;
    raise exception using errcode='PT409', message='task_unavailable';
  end if;
  if v_task.active_run_id is not null then raise exception using errcode='PT409', message='run_active'; end if;

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
