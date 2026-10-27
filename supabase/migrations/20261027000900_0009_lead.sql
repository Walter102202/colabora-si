-- 0009_lead: the Lead role (§IV.5.1 P3, §IV.5.4, §IV.9.4, D10). A Lead delegates subtasks, reviews them from a
-- run of its own on the parent task, and closes them only by brief policy or a verified deterministic check.
-- Closing anything else stays human (close_task, D10).

create table private.webhook_receipts (
  provider          text not null,
  provider_event_id text not null,
  agent_id          uuid references public.agents(id) on delete cascade,
  result            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  primary key (provider, provider_event_id)
);
alter table private.webhook_receipts enable row level security;
revoke all on private.webhook_receipts from public, anon, authenticated;

-- Calling agent when it is the Lead (role 'lead') delegated on p_parent_task_id; null otherwise.
create or replace function private.lead_of(p_parent_task_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.agent_tasks p join public.agents a on a.id = p.delegate_agent_id
   where p.id = p_parent_task_id and a.role = 'lead' and a.id = private.current_agent_id();
$$;
revoke execute on function private.lead_of(uuid) from public;

-- ============ create_subtask ============

create or replace function public.create_subtask(p_parent_task_id uuid, p_row_page_id text, p_brief jsonb,
  p_delegate_agent_id uuid default null, p_reference_task_ids uuid[] default '{}', p_depends_on_task_ids uuid[] default '{}',
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lead uuid; v_parent public.agent_tasks%rowtype; v_max int; v_count int;
begin
  if not private.is_agent() or private.current_agent_id() is null then
    raise exception using errcode = 'PT403', message = 'lead_only';
  end if;
  select * into v_parent from public.agent_tasks where id = p_parent_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'parent_not_found'; end if;
  v_lead := private.lead_of(p_parent_task_id);
  if v_lead is null then raise exception using errcode = 'PT403', message = 'lead_only'; end if;
  select (b.policies->>'team_size_max')::int into v_max
    from public.task_briefs b where b.task_id = v_parent.id and b.version = v_parent.brief_version;
  if v_max is not null then
    select count(*) into v_count from public.agent_tasks where parent_task_id = v_parent.id and state <> 'cancelled';
    if v_count >= v_max then
      raise exception using errcode = 'PT422', message = 'team_size_exceeded', detail = jsonb_build_object('max', v_max)::text;
    end if;
  end if;
  return public.create_agent_task(p_row_page_id, p_brief, p_delegate_agent_id, p_parent_task_id,
                                  p_reference_task_ids, p_depends_on_task_ids, p_idempotency_key);
end $$;

-- ============ review_task ============

-- A person with write access to the row, or the Lead of the parent task from its own run on the parent
-- (p_run_id, or app.run_id inside an RPC). changes_requested beyond max_review_rounds escalates to a person.
create or replace function public.review_task(p_task_id uuid, p_verdict text, p_findings jsonb default '[]'::jsonb,
  p_evidence jsonb default '[]'::jsonb, p_artifact_id uuid default null, p_run_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_art public.agent_artifacts%rowtype; v_agent uuid; v_run uuid;
        v_reviewer uuid; v_reviewer_type text; v_bad text; v_id uuid; v_rounds int; v_state text; v_text text;
begin
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    v_run := coalesce(p_run_id, private.current_run_id());
    if private.lead_of(v_t.parent_task_id) is null or v_run is null or not exists (
         select 1 from public.agent_runs r where r.id = v_run and r.agent_id = v_agent and r.task_id = v_t.parent_task_id
            and r.status in ('running','waiting')) then
      raise exception using errcode = 'PT403', message = 'forbidden', detail = 'review from your own run on the parent task';
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
                                 'source', case when v_reviewer_type = 'agent' then 'lead' else 'row_panel' end, 'review_id', v_id),
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

  perform private.audit(v_t.workspace_id, 'review.add', jsonb_build_object('task_id', v_t.id, 'review_id', v_id, 'verdict', p_verdict));
  return jsonb_build_object('review_id', v_id, 'task_state', v_state, 'rounds', v_rounds);
end $$;

-- ============ close_subtask ============

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
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close_subtask', jsonb_build_object('task_id', v_t.id));
  return jsonb_build_object('task_state', 'done');
end $$;

-- ============ list_subtasks ============

-- Subtasks with their dependencies; RLS of agent_tasks applies (security_invoker).
create view public.list_subtasks with (security_invoker = true) as
  select t.parent_task_id, t.id as task_id, t.context_id, t.title, t.state, t.review_state, t.waiting_on, t.acceptance,
         t.delegate_agent_id, t.row_page_id, t.depends_on_task_ids, t.review_rounds, t.max_review_rounds,
         t.brief_version, t.brief_stale, t.last_activity_at, t.created_at
    from public.agent_tasks t
   where t.parent_task_id is not null;
revoke all on public.list_subtasks from public, anon;
grant select on public.list_subtasks to authenticated;

revoke all on function public.create_subtask(uuid, text, jsonb, uuid, uuid[], uuid[], text) from public, anon;
revoke all on function public.review_task(uuid, text, jsonb, jsonb, uuid, uuid) from public, anon;
revoke all on function public.close_subtask(uuid, text, jsonb) from public, anon;
grant execute on function public.create_subtask(uuid, text, jsonb, uuid, uuid[], uuid[], text) to authenticated;
grant execute on function public.review_task(uuid, text, jsonb, jsonb, uuid, uuid) to authenticated;
grant execute on function public.close_subtask(uuid, text, jsonb) to authenticated;
