-- 0006_control_rpcs: task control RPCs (§IV.5.1 P2, §IV.5.4). Every RPC is security definer with an empty
-- search_path and repeats its own access check. Agent RPCs resolve the actor with private.task_actor_agent_id()
-- (token agent or OAuth-linked agent, D9) and call private.check_rate first. decide_approval and close_task are
-- humans-only and require a direct session (no OAuth client_id).

-- ============ private helpers ============

-- Next activity seq for a task (monotonic per task, taken under a row lock on the task).
create or replace function private.next_seq(p_task_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  perform 1 from public.agent_tasks where id = p_task_id for update;
  select coalesce(max(seq), 0) + 1 into v from public.agent_activities where task_id = p_task_id;
  return v;
end $$;

create or replace function private.next_event_seq(p_task_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  perform 1 from public.agent_tasks where id = p_task_id for update;
  select coalesce(max(seq), 0) + 1 into v from public.agent_events where task_id = p_task_id;
  return v;
end $$;

-- sha256(action | task_id | artifact_version | params); jsonb::text is canonical for equal values.
create or replace function private.action_hash(p_action text, p_task_id uuid, p_artifact_version int, p_params jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(
    coalesce(p_action, '') || '|' || p_task_id::text || '|' || coalesce(p_artifact_version::text, '') || '|' || coalesce(p_params, '{}'::jsonb)::text,
    'utf8'), 'sha256'), 'hex');
$$;

-- An action needs a human approval unless the current brief lists it in policies.preapproved.
create or replace function private.requires_approval(p_action text, p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not coalesce((
    select (b.policies -> 'preapproved') ? p_action
      from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version
     where t.id = p_task_id), false);
$$;

-- Same chain walk as private.agent_can, for an explicit agent (used when someone else assigns it work).
create or replace function private.agent_has_grant(p_agent_id uuid, p_page_id text, p_scope text)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive chain as (
    select p.id, p.parent_id, 0 as depth from public.pages p where p.id = p_page_id
    union all
    select p.id, p.parent_id, c.depth + 1 from chain c
    join public.pages p on p.id = c.parent_id where c.depth < 3
  )
  select exists (
    select 1 from public.agent_grants g join chain c on c.id = g.page_id
     where g.agent_id = p_agent_id and g.revoked_at is null
       and (g.expires_at is null or g.expires_at > now())
       and (c.depth = 0 or g.inherit) and p_scope = any (g.scopes));
$$;

-- D11: when a task gets a delegate, grant write+comment on the row and read on the brief's page sources if missing.
create or replace function private.ensure_delegate_grants(p_agent_id uuid, p_ws uuid, p_row_page_id text, p_sources jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_page text; v_by uuid := (select auth.uid());
begin
  if p_agent_id is null then return; end if;
  if not (private.agent_has_grant(p_agent_id, p_row_page_id, 'write') and private.agent_has_grant(p_agent_id, p_row_page_id, 'comment')) then
    insert into public.agent_grants (workspace_id, agent_id, page_id, scopes, inherit, granted_by)
    values (p_ws, p_agent_id, p_row_page_id, array['read','write','comment'], true, v_by)
    on conflict (agent_id, page_id) do update
      set scopes = array(select distinct s from unnest(public.agent_grants.scopes || array['read','write','comment']) s order by s),
          revoked_at = null, granted_by = excluded.granted_by;
    perform private.audit(p_ws, 'grant.add', jsonb_build_object('agent_id', p_agent_id, 'page_id', p_row_page_id, 'auto', true));
  end if;
  for v_page in
    select s->>'ref' from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) s
     where s->>'kind' = 'page' and exists (select 1 from public.pages p where p.id = s->>'ref' and p.workspace_id = p_ws)
  loop
    if not private.agent_has_grant(p_agent_id, v_page, 'read') then
      insert into public.agent_grants (workspace_id, agent_id, page_id, scopes, inherit, granted_by)
      values (p_ws, p_agent_id, v_page, array['read'], true, v_by)
      on conflict (agent_id, page_id) do update
        set scopes = array(select distinct s from unnest(public.agent_grants.scopes || array['read']) s order by s),
            revoked_at = null, granted_by = excluded.granted_by;
      perform private.audit(p_ws, 'grant.add', jsonb_build_object('agent_id', p_agent_id, 'page_id', v_page, 'auto', true));
    end if;
  end loop;
end $$;

-- Validates a brief payload: objective required, done_when an array of criteria with unique non-empty ids.
create or replace function private.validate_brief(p_brief jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_brief) is distinct from 'object' or coalesce(btrim(p_brief->>'objective'), '') = '' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'objective is required';
  end if;
  if p_brief ? 'done_when' then
    if jsonb_typeof(p_brief->'done_when') <> 'array' then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'done_when must be an array';
    end if;
    if exists (select 1 from jsonb_array_elements(p_brief->'done_when') c where coalesce(c->>'id', '') = '')
       or (select count(*) from jsonb_array_elements(p_brief->'done_when')) <>
          (select count(distinct c->>'id') from jsonb_array_elements(p_brief->'done_when') c) then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'done_when ids must be unique';
    end if;
  end if;
end $$;

-- Resolves the calling agent's run: agent enabled, rate limit, ownership. Raises on any failure.
create or replace function private.own_run(p_run_id uuid, p_lock boolean default true)
returns public.agent_runs language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_r public.agent_runs%rowtype;
begin
  v_agent := private.task_actor_agent_id();
  if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
  perform private.check_rate(v_agent);
  if p_lock then
    select * into v_r from public.agent_runs where id = p_run_id and agent_id = v_agent for update;
  else
    select * into v_r from public.agent_runs where id = p_run_id and agent_id = v_agent;
  end if;
  if not found then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  return v_r;
end $$;

-- Queues task.start for tasks waiting on p_task_id once all their dependencies are done.
create or replace function private.release_dependents(p_task_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select t.workspace_id, t.id, null, t.delegate_agent_id, 'task.start',
         jsonb_build_object('context_id', t.context_id, 'brief_version', t.brief_version, 'released_by', p_task_id),
         private.next_event_seq(t.id)
    from public.agent_tasks t join public.agents a on a.id = t.delegate_agent_id
   where p_task_id = any (t.depends_on_task_ids) and t.state = 'queued'
     and coalesce((a.capabilities->>'start')::boolean, false)
     and not exists (select 1 from unnest(t.depends_on_task_ids) d
                      join public.agent_tasks x on x.id = d where x.state <> 'done');
end $$;

-- Shared body of request_approval (the tool) and of the server-side route (begin_external_op).
create or replace function private.request_approval_core(p_run public.agent_runs, p_action text, p_params jsonb,
  p_artifact_id uuid, p_question text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_ver int; v_hash text; v_id uuid;
begin
  if coalesce(p_action, '') = '' or jsonb_typeof(coalesce(p_params, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select * into v_t from public.agent_tasks where id = p_run.task_id for update;
  if p_artifact_id is not null then
    select version into v_ver from public.agent_artifacts where id = p_artifact_id and task_id = v_t.id;
    if not found then raise exception using errcode = 'PT404', message = 'artifact_not_found'; end if;
  end if;
  v_hash := private.action_hash(p_action, v_t.id, v_ver, coalesce(p_params, '{}'::jsonb));
  select id into v_id from public.agent_approvals where task_id = v_t.id and status = 'pending' and action_hash = v_hash limit 1;
  if found then return jsonb_build_object('approval_id', v_id, 'action_hash', v_hash, 'status', 'pending'); end if;

  insert into public.agent_approvals (workspace_id, task_id, run_id, kind, action, action_hash, params, artifact_id,
                                      artifact_version, question, options, requested_by_type, requested_by_id)
  values (v_t.workspace_id, v_t.id, p_run.id, 'action', p_action, v_hash, coalesce(p_params, '{}'::jsonb), p_artifact_id,
          v_ver, coalesce(p_question, ''), array['approve','edit','reject'], 'agent', p_run.agent_id)
  returning id into v_id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, p_run.id, private.next_seq(v_t.id), 'elicitation',
          jsonb_build_object('approval_id', v_id, 'question', coalesce(p_question, ''), 'options', to_jsonb(array['approve','edit','reject']),
                             'action', p_action), 'agent', p_run.agent_id);
  update public.agent_runs set status = 'waiting' where id = p_run.id and status = 'running';
  update public.agent_tasks set state = 'input_required', waiting_on = 'human', updated_at = now()
   where id = v_t.id and state in ('working','input_required');
  insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, approval_id, actor_id, actor_type, payload)
  values (v_t.workspace_id, v_t.owner_user_id, 'approval_requested', v_t.row_page_id, v_t.id, v_id, p_run.agent_id, 'agent',
          jsonb_build_object('action', p_action, 'question', left(coalesce(p_question, ''), 280)));
  return jsonb_build_object('approval_id', v_id, 'action_hash', v_hash, 'status', 'pending');
end $$;

-- Single-use receipt check, called inside the transaction of the action it authorizes (§IV.5.4).
create or replace function private.consume_approval(p_receipt uuid, p_action text, p_params jsonb, p_artifact_version int, p_op text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_a public.agent_approvals%rowtype;
begin
  select * into v_a from public.agent_approvals where receipt = p_receipt for update;
  if not found then raise exception using errcode='PT404', message='receipt_not_found'; end if;
  if v_a.status = 'consumed' then raise exception using errcode='PT409', message='approval_consumed'; end if;
  if v_a.status <> 'decided' or v_a.decision not in ('approve','edit') then raise exception using errcode='PT422', message='approval_not_granted'; end if;
  if v_a.receipt_expires_at < now() then raise exception using errcode='PT410', message='receipt_expired'; end if;
  if v_a.action_hash <> private.action_hash(p_action, v_a.task_id, p_artifact_version, p_params) then
    raise exception using errcode='PT409', message='approval_mismatch';
  end if;
  update public.agent_approvals set status='consumed', consumed_at=now(), consumed_by_op=p_op where id=v_a.id;
  return v_a.id;
end $$;

-- All done_when criteria with check='deterministic' are verified, with evidence, in a current review.
create or replace function private.deterministic_checks_pass(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' = 'deterministic')
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' = 'deterministic'
         and not exists (
           select 1 from public.agent_reviews r, jsonb_array_elements(r.findings) f
            where r.task_id = t.id and r.outdated_by is null
              and f->>'criterion_id' = c->>'id' and f->>'status' = 'verified'
              and jsonb_array_length(r.evidence) > 0
              and (c->>'command' is null or exists (
                    select 1 from jsonb_array_elements(r.evidence) e where e->>'ref' = c->>'command'))));
$$;

-- Adds tokens and cost to a run; enforces the hard budget for agents the platform dispatches (capabilities.cost).
create or replace function private.record_cost_core(p_run_id uuid, p_input_tokens bigint, p_output_tokens bigint,
  p_model text, p_cost_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_p public.model_prices%rowtype; v_add numeric := 0; v_kind text;
        v_a public.agents%rowtype; v_spent numeric; v_t public.agent_tasks%rowtype;
begin
  select * into v_r from public.agent_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if coalesce(p_input_tokens, 0) < 0 or coalesce(p_output_tokens, 0) < 0 or coalesce(p_cost_usd, 0) < 0 then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select * into v_p from public.model_prices where model = coalesce(p_model, v_r.model);
  if p_cost_usd is not null then
    v_add := p_cost_usd; v_kind := 'measured';
  elsif v_p.model is not null then
    v_add := (coalesce(p_input_tokens, 0) * v_p.input_usd_per_mtok + coalesce(p_output_tokens, 0) * v_p.output_usd_per_mtok) / 1000000;
    v_kind := case when v_r.cost_kind = 'measured' then 'measured' else 'estimated' end;
  else
    v_kind := v_r.cost_kind;
  end if;
  update public.agent_runs
     set input_tokens = input_tokens + coalesce(p_input_tokens, 0), output_tokens = output_tokens + coalesce(p_output_tokens, 0),
         model = coalesce(p_model, model), cost_usd = cost_usd + v_add, cost_kind = v_kind
   where id = v_r.id returning * into v_r;

  select * into v_a from public.agents where id = v_r.agent_id;
  if v_a.monthly_budget_usd is not null and coalesce((v_a.capabilities->>'cost')::boolean, false)
     and v_r.status in ('running','waiting') and v_r.stop_requested_at is null then
    select coalesce(sum(cost_usd), 0) into v_spent from public.agent_runs
     where agent_id = v_a.id and started_at >= date_trunc('month', now());
    if v_spent > v_a.monthly_budget_usd then
      update public.agent_runs set stop_requested_at = now() where id = v_r.id;
      select * into v_t from public.agent_tasks where id = v_r.task_id;
      insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
      values (v_r.workspace_id, v_r.task_id, v_r.id, v_r.agent_id, 'task.stop',
              jsonb_build_object('reason', 'budget_exceeded'), private.next_event_seq(v_r.task_id));
      insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
      values (v_r.workspace_id, v_a.sponsor_user_id, 'task_failed', v_t.row_page_id, v_t.id, v_a.id, 'agent',
              jsonb_build_object('reason', 'budget_exceeded', 'spent_usd', v_spent, 'budget_usd', v_a.monthly_budget_usd));
    end if;
  end if;
  return jsonb_build_object('cost_usd', v_r.cost_usd, 'cost_kind', v_r.cost_kind);
end $$;

revoke execute on function private.next_seq(uuid) from public;
revoke execute on function private.next_event_seq(uuid) from public;
revoke execute on function private.action_hash(text, uuid, int, jsonb) from public;
revoke execute on function private.requires_approval(text, uuid) from public;
revoke execute on function private.agent_has_grant(uuid, text, text) from public;
revoke execute on function private.ensure_delegate_grants(uuid, uuid, text, jsonb) from public;
revoke execute on function private.validate_brief(jsonb) from public;
revoke execute on function private.own_run(uuid, boolean) from public;
revoke execute on function private.release_dependents(uuid) from public;
revoke execute on function private.request_approval_core(public.agent_runs, text, jsonb, uuid, text) from public;
revoke execute on function private.consume_approval(uuid, text, jsonb, int, text) from public;
revoke execute on function private.deterministic_checks_pass(uuid) from public;
revoke execute on function private.record_cost_core(uuid, bigint, bigint, text, numeric) from public;

-- ============ tasks and briefs ============

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

  insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, decisions, sources,
                                  open_questions, next_step, policies, author_id, author_type)
  values (v_id, 1, v_page.workspace_id, p_brief->>'objective', coalesce(p_brief->>'constraints', ''),
          coalesce(p_brief->'done_when', '[]'), coalesce(p_brief->'decisions', '[]'), coalesce(p_brief->'sources', '[]'),
          coalesce(p_brief->'open_questions', '[]'), coalesce(p_brief->>'next_step', ''), coalesce(p_brief->'policies', '{}'),
          v_author, v_author_type);

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
        v_author uuid; v_author_type text; v_bad text; v_new jsonb; v_ver int; v_d public.agents%rowtype;
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
  v_new := (to_jsonb(v_b) - 'task_id' - 'version' - 'workspace_id' - 'author_id' - 'author_type' - 'created_at')
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
  insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, decisions, sources,
                                  open_questions, next_step, policies, author_id, author_type)
  values (v_t.id, v_ver, v_t.workspace_id, v_new->>'objective', coalesce(v_new->>'constraints', ''),
          coalesce(v_new->'done_when', '[]'), coalesce(v_new->'decisions', '[]'), coalesce(v_new->'sources', '[]'),
          coalesce(v_new->'open_questions', '[]'), coalesce(v_new->>'next_step', ''), coalesce(v_new->'policies', '{}'),
          v_author, v_author_type);

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

-- ============ runs ============

create or replace function public.claim_task(p_task_id uuid default null, p_harness text default 'custom',
  p_external_session_id text default null, p_brief_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_task public.agent_tasks%rowtype; v_run uuid; v_brief jsonb; v_ver int;
begin
  v_agent := private.task_actor_agent_id();
  if v_agent is null then raise exception using errcode='PT403', message='agent_disabled'; end if;
  perform private.check_rate(v_agent);

  select t.* into v_task from public.agent_tasks t
   where (p_task_id is null or t.id = p_task_id)
     and t.state in ('queued','input_required','ready_for_review','done')
     and (t.delegate_agent_id = v_agent
          or (t.delegate_agent_id is null and private.agent_can(t.row_page_id,'write')))
     and (p_task_id is not null or t.state = 'queued')
   order by t.created_at
   for update skip locked limit 1;
  if not found then
    if p_task_id is null then return jsonb_build_object('task_id', null); end if;
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

  perform set_config('app.run_id', v_run::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_task.workspace_id, v_task.id, v_run, private.next_seq(v_task.id), 'action',
          jsonb_build_object('op','claim','harness',p_harness,'brief_version',v_ver), 'agent', v_agent);

  select to_jsonb(b) into v_brief from public.task_briefs b where b.task_id=v_task.id and b.version=v_ver;
  return jsonb_build_object(
    'task_id', v_task.id, 'run_id', v_run, 'context_id', v_task.context_id,
    'row_page_id', v_task.row_page_id, 'brief', v_brief,
    'artifacts', (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.agent_artifacts a
                   where a.task_id=v_task.id and a.superseded_by is null),
    'recent_activities', (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
        select type, body, author_type, created_at from public.agent_activities
         where task_id=v_task.id and not ephemeral order by seq desc limit 20) x));
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
                                                                      'created_at', a.created_at) order by a.seq), '[]')
                          from public.agent_activities a
                         where a.task_id = v_r.task_id and a.type = 'prompt' and a.seq > v_from));
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
             select 1 from public.agent_approvals ap where ap.run_id = v_r.id and ap.status = 'pending') then 'running'
           else status end
   where id = v_r.id;
end $$;

create or replace function public.post_activity(p_run_id uuid, p_type text, p_body jsonb, p_ephemeral boolean default false,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_id uuid; v_seq bigint; v_state text;
begin
  v_r := private.own_run(p_run_id);
  if p_idempotency_key is not null then
    select a.id, a.seq into v_id, v_seq from public.agent_activities a where a.task_id = v_r.task_id and a.idempotency_key = p_idempotency_key;
    if found then
      select state into v_state from public.agent_tasks where id = v_r.task_id;
      return jsonb_build_object('activity_id', v_id, 'seq', v_seq, 'task_state', v_state);
    end if;
  end if;
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if p_type is null or p_type not in ('thought','action','response','error') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'type';
  end if;
  if jsonb_typeof(p_body) is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'body'; end if;
  if p_type = 'action' and p_body->>'op' = 'external' and not exists (
       select 1 from public.external_ops o where o.op_id = (p_body->>'external_op_id')::uuid and o.task_id = v_r.task_id) then
    raise exception using errcode = 'PT422', message = 'unknown_external_op';
  end if;

  perform set_config('app.run_id', v_r.id::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, ephemeral, author_type, author_id, idempotency_key)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), p_type, p_body, coalesce(p_ephemeral, false),
          'agent', v_r.agent_id, p_idempotency_key)
  returning id, seq into v_id, v_seq;
  select state into v_state from public.agent_tasks where id = v_r.task_id;
  return jsonb_build_object('activity_id', v_id, 'seq', v_seq, 'task_state', v_state);
end $$;

-- ============ input and approvals ============

create or replace function public.request_input(p_run_id uuid, p_question text, p_options text[] default array['respond','ignore'],
  p_kind text default 'elicitation')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_id uuid; v_opts text[] := coalesce(p_options, array['respond','ignore']);
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_kind, '') not in ('elicitation','plan','escalation') or coalesce(btrim(p_question), '') = ''
     or cardinality(v_opts) = 0 or not (v_opts <@ array['approve','reject','edit','respond','ignore']) then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  insert into public.agent_approvals (workspace_id, task_id, run_id, kind, question, options, requested_by_type, requested_by_id)
  values (v_t.workspace_id, v_t.id, v_r.id, p_kind, p_question, v_opts, 'agent', v_r.agent_id)
  returning id into v_id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_r.id, private.next_seq(v_t.id), 'elicitation',
          jsonb_build_object('approval_id', v_id, 'question', p_question, 'options', to_jsonb(v_opts)), 'agent', v_r.agent_id);
  update public.agent_runs set status = 'waiting' where id = v_r.id and status = 'running';
  update public.agent_tasks set state = 'input_required', waiting_on = 'human', updated_at = now()
   where id = v_t.id and state in ('working','input_required');
  insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, approval_id, actor_id, actor_type, payload)
  values (v_t.workspace_id, v_t.owner_user_id, 'input_required', v_t.row_page_id, v_t.id, v_id, v_r.agent_id, 'agent',
          jsonb_build_object('question', left(p_question, 280), 'kind', p_kind));
  return jsonb_build_object('approval_id', v_id);
end $$;

create or replace function public.request_approval(p_run_id uuid, p_action text, p_params jsonb, p_artifact_id uuid default null,
  p_question text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_res jsonb;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  v_res := private.request_approval_core(v_r, p_action, p_params, p_artifact_id, p_question);
  return jsonb_build_object('approval_id', v_res->'approval_id', 'action_hash', v_res->'action_hash');
end $$;

create or replace function public.decide_approval(p_approval_id uuid, p_decision text, p_response jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agent_approvals%rowtype; v_t public.agent_tasks%rowtype; v_receipt uuid; v_params jsonb;
begin
  if private.principal_type() <> 'human' then raise exception using errcode='PT403', message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403', message='direct_session_required'; end if;
  select * into v_a from public.agent_approvals where id = p_approval_id for update;
  if not found then raise exception using errcode='PT404', message='not_found'; end if;
  select * into v_t from public.agent_tasks where id = v_a.task_id;
  if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then raise exception using errcode='PT403', message='forbidden'; end if;
  if v_a.status <> 'pending' then raise exception using errcode='PT409', message='approval_not_pending'; end if;
  if v_a.expires_at < now() then update public.agent_approvals set status='expired' where id=v_a.id;
     raise exception using errcode='PT410', message='approval_expired'; end if;
  if not (p_decision = any (v_a.options)) then raise exception using errcode='PT422', message='decision_not_offered'; end if;

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

-- ============ external operations and artifacts ============

create or replace function public.begin_external_op(p_run_id uuid, p_provider text, p_action text, p_params jsonb,
  p_approval_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_hash text; v_op public.external_ops%rowtype; v_approval uuid; v_ver int; v_res jsonb;
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

  if private.requires_approval(p_action, v_r.task_id) then
    if p_approval_receipt is null then
      v_res := private.request_approval_core(v_r, p_action, p_params, null, 'Approve ' || p_action || ' via ' || p_provider || '?');
      return jsonb_build_object('status', 'approval_required', 'approval_id', v_res->'approval_id');
    end if;
    select artifact_version into v_ver from public.agent_approvals where receipt = p_approval_receipt;
    v_approval := private.consume_approval(p_approval_receipt, p_action, p_params, v_ver, 'begin_external_op');
  end if;

  insert into public.external_ops (workspace_id, task_id, run_id, provider, action, params_hash, params, idempotency_key, approval_id)
  values (v_r.workspace_id, v_r.task_id, v_r.id, p_provider, p_action, v_hash, p_params, gen_random_uuid()::text, v_approval)
  returning * into v_op;
  return jsonb_build_object('op_id', v_op.op_id, 'idempotency_key', v_op.idempotency_key, 'status', v_op.status);
end $$;

create or replace function public.finish_external_op(p_op_id uuid, p_status text, p_provider_ref text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_op public.external_ops%rowtype; v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype;
begin
  select * into v_op from public.external_ops where op_id = p_op_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  v_r := private.own_run(v_op.run_id);
  if p_status is null or p_status not in ('done','unknown','failed') then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  update public.external_ops set status = p_status, provider_ref = p_provider_ref, last_error = p_error,
         checked_at = now(), attempts = attempts + 1
   where op_id = v_op.op_id;
  perform set_config('app.run_id', v_r.id::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_op.workspace_id, v_op.task_id, v_r.id, private.next_seq(v_op.task_id), 'action',
          jsonb_build_object('op', 'external', 'external_op_id', v_op.op_id, 'status', p_status, 'provider_ref', p_provider_ref,
                             'summary', v_op.provider || ' ' || v_op.action || ': ' || p_status), 'agent', v_r.agent_id);
  if p_status = 'unknown' then
    select * into v_t from public.agent_tasks where id = v_op.task_id;
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
    values (v_op.workspace_id, v_t.owner_user_id, 'input_required', v_t.row_page_id, v_t.id, v_r.agent_id, 'agent',
            jsonb_build_object('external_op_id', v_op.op_id, 'check_manually', true, 'summary', v_op.provider || ' ' || v_op.action));
  end if;
end $$;

create or replace function public.add_artifact(p_run_id uuid, p_kind text, p_ref text, p_title text, p_satisfies text[] default '{}',
  p_content_hash text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_prev public.agent_artifacts%rowtype;
        v_id uuid := gen_random_uuid(); v_ver int := 1; v_rev bigint; v_bad text; v_author uuid; v_author_type text;
begin
  if private.is_agent() or private.linked_agent_id() is not null then
    v_r := private.own_run(p_run_id);
    v_author := v_r.agent_id; v_author_type := 'agent';
  else
    select * into v_r from public.agent_runs where id = p_run_id for update;
    if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
    v_author := (select auth.uid()); v_author_type := 'human';
  end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  if v_author_type = 'human' and not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  if p_kind is null or p_kind not in ('page','file','diff','query','image','external') or coalesce(p_ref, '') = '' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select s into v_bad from unnest(coalesce(p_satisfies, '{}')) s
   where not exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
                      where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'id' = s) limit 1;
  if v_bad is not null then raise exception using errcode = 'PT422', message = 'unknown_criterion', detail = v_bad; end if;
  if p_kind = 'page' then
    select revision into v_rev from public.pages where id = p_ref and workspace_id = v_t.workspace_id;
    if not found then raise exception using errcode = 'PT404', message = 'page_not_found'; end if;
  end if;

  select * into v_prev from public.agent_artifacts
   where task_id = v_t.id and kind = p_kind and ref = p_ref and superseded_by is null
   order by version desc limit 1 for update;
  if found then v_ver := v_prev.version + 1; end if;
  insert into public.agent_artifacts (id, workspace_id, task_id, run_id, kind, ref, version, page_revision, content_hash, title,
                                      satisfies, author_type, author_id)
  values (v_id, v_t.workspace_id, v_t.id, v_r.id, p_kind, p_ref, v_ver, v_rev, p_content_hash, coalesce(p_title, ''),
          coalesce(p_satisfies, '{}'), v_author_type, v_author);
  -- The new row exists before the previous one points at it (FK); 0007 outdates reviews on this update.
  if v_prev.id is not null then
    update public.agent_artifacts set superseded_by = v_id where id = v_prev.id;
  end if;
  return jsonb_build_object('artifact_id', v_id, 'version', v_ver);
end $$;

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

-- ============ messages, stop and run end ============

create or replace function public.send_agent_message(p_task_id uuid, p_body text, p_signal text default 'feedback',
  p_block_ids text[] default '{}', p_comment_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_agent uuid; v_author uuid; v_author_type text; v_source text; v_delivery text;
        v_run public.agent_runs%rowtype; v_activity uuid;
begin
  if p_signal is null or p_signal not in ('continue','feedback','stop') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'signal';
  end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    if not exists (select 1 from public.agent_tasks p join public.agents a on a.id = p.delegate_agent_id
                    where p.id = v_t.parent_task_id and p.delegate_agent_id = v_agent and a.role = 'lead') then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_author := v_agent; v_author_type := 'agent'; v_source := 'lead';
  else
    if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_author := (select auth.uid()); v_author_type := 'human';
    v_source := case when p_comment_id is not null then 'comment' else 'row_panel' end;
  end if;

  if v_t.state in ('cancelled','failed') and p_signal <> 'continue' then
    raise exception using errcode = 'PT409', message = 'task_closed';
  end if;
  if v_t.state = 'done' and p_signal = 'stop' then
    raise exception using errcode = 'PT409', message = 'task_closed';
  end if;

  if p_signal = 'stop' then
    if v_t.active_run_id is null then
      update public.agent_tasks set state='cancelled', active_run_id=null, waiting_on=null, updated_at=now() where id=v_t.id;
      update public.agent_approvals set status='cancelled' where task_id=v_t.id and status='pending';
      v_delivery := 'cancelled';
    else
      update public.agent_runs set stop_requested_at=coalesce(stop_requested_at, now()) where id=v_t.active_run_id
        returning * into v_run;
      insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
      values (v_t.workspace_id, v_t.id, v_run.id, v_run.agent_id, 'task.stop',
              jsonb_build_object('reason', 'stop', 'text', p_body), private.next_event_seq(v_t.id));
      v_delivery := 'stop_requested';
    end if;
  else
    if v_t.state in ('done','failed','cancelled') then
      update public.agent_tasks set state='queued', acceptance='pending', review_state='none', waiting_on=null,
             closed_at=null, closed_by=null, updated_at=now() where id=v_t.id;
    elsif v_t.state = 'input_required' and v_t.active_run_id is null then
      update public.agent_tasks set state='queued', waiting_on=null, updated_at=now() where id=v_t.id;
    end if;
    if v_t.active_run_id is not null then
      v_delivery := 'queued_for_run';
    elsif exists (select 1 from public.agents a where a.id=v_t.delegate_agent_id and coalesce((a.capabilities->>'continue')::boolean, false)) then
      insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
      values (v_t.workspace_id, v_t.id, null, v_t.delegate_agent_id,
              case p_signal when 'continue' then 'task.continue' else 'task.feedback' end,
              jsonb_build_object('text', p_body, 'signal', p_signal, 'source', v_source), private.next_event_seq(v_t.id));
      v_delivery := 'dispatched';
    else
      v_delivery := 'queued_for_next_session';
    end if;
  end if;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_t.active_run_id, private.next_seq(v_t.id), 'prompt',
          jsonb_build_object('text', coalesce(p_body, ''), 'signal', p_signal, 'source', v_source, 'comment_id', p_comment_id,
                             'block_ids', to_jsonb(coalesce(p_block_ids, '{}'))), v_author_type, v_author)
  returning id into v_activity;
  return jsonb_build_object('activity_id', v_activity, 'delivery', v_delivery);
end $$;

create or replace function public.ack_stop(p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype;
begin
  v_r := private.own_run(p_run_id);
  if v_r.stop_requested_at is null then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  update public.agent_runs set stop_acked_at = coalesce(stop_acked_at, now()),
         status = case when status in ('running','waiting') then 'cancelled' else status end,
         ended_at = coalesce(ended_at, now())
   where id = v_r.id;
  update public.agent_tasks set state = 'cancelled', active_run_id = null, waiting_on = null, updated_at = now()
   where active_run_id = v_r.id;
  update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending';
  update public.agent_events set acked_at = now(), status = 'acked'
   where run_id = v_r.id and type = 'task.stop' and acked_at is null;
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
  update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending';

  v_state := case
    when p_status = 'error' and coalesce(p_terminal, false) then 'failed'
    when p_status = 'cancelled' and v_r.stop_requested_at is not null then 'cancelled'
    else 'queued' end;
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

create or replace function public.record_cost(p_run_id uuid, p_input_tokens bigint, p_output_tokens bigint, p_model text,
  p_cost_usd numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    perform private.own_run(p_run_id);
  end if;
  return private.record_cost_core(p_run_id, p_input_tokens, p_output_tokens, p_model, p_cost_usd);
end $$;

-- ============ closing ============

create or replace function public.close_task(p_task_id uuid, p_acceptance text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_run public.agent_runs%rowtype; v_uid uuid := (select auth.uid());
begin
  if private.principal_type() <> 'human' then raise exception using errcode='PT403', message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403', message='direct_session_required'; end if;
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

-- Full version (replaces the P1 body from 0002): also cancels active runs and hands open tasks back to a person.
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
  update public.agent_tasks set state = 'input_required', waiting_on = 'human', active_run_id = null, updated_at = now()
   where delegate_agent_id = p_agent_id and state in ('queued','working','input_required');
  perform private.audit(v_a.workspace_id, 'agent.revoke', jsonb_build_object('agent_id', p_agent_id, 'reason', p_reason));
end $$;

-- ============ grants ============

revoke all on function public.create_agent_task(text, jsonb, uuid, uuid, uuid[], uuid[], text) from public, anon;
revoke all on function public.update_brief(uuid, jsonb) from public, anon;
revoke all on function public.claim_task(uuid, text, text, int) from public, anon;
revoke all on function public.heartbeat(uuid, jsonb, bigint) from public, anon;
revoke all on function public.touch_run_wait(uuid, uuid) from public, anon;
revoke all on function public.post_activity(uuid, text, jsonb, boolean, text) from public, anon;
revoke all on function public.request_input(uuid, text, text[], text) from public, anon;
revoke all on function public.request_approval(uuid, text, jsonb, uuid, text) from public, anon;
revoke all on function public.decide_approval(uuid, text, jsonb) from public, anon;
revoke all on function public.begin_external_op(uuid, text, text, jsonb, uuid) from public, anon;
revoke all on function public.finish_external_op(uuid, text, text, text) from public, anon;
revoke all on function public.add_artifact(uuid, text, text, text, text[], text) from public, anon;
revoke all on function public.submit_for_review(uuid, text, uuid[]) from public, anon;
revoke all on function public.send_agent_message(uuid, text, text, text[], text) from public, anon;
revoke all on function public.ack_stop(uuid) from public, anon;
revoke all on function public.end_run(uuid, text, text, jsonb, boolean) from public, anon;
revoke all on function public.record_cost(uuid, bigint, bigint, text, numeric) from public, anon;
revoke all on function public.close_task(uuid, text, text) from public, anon;
revoke all on function public.revoke_agent(uuid, text) from public, anon;

grant execute on function public.create_agent_task(text, jsonb, uuid, uuid, uuid[], uuid[], text) to authenticated;
grant execute on function public.update_brief(uuid, jsonb) to authenticated;
grant execute on function public.claim_task(uuid, text, text, int) to authenticated;
grant execute on function public.heartbeat(uuid, jsonb, bigint) to authenticated;
grant execute on function public.touch_run_wait(uuid, uuid) to authenticated;
grant execute on function public.post_activity(uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function public.request_input(uuid, text, text[], text) to authenticated;
grant execute on function public.request_approval(uuid, text, jsonb, uuid, text) to authenticated;
grant execute on function public.decide_approval(uuid, text, jsonb) to authenticated;
grant execute on function public.begin_external_op(uuid, text, text, jsonb, uuid) to authenticated;
grant execute on function public.finish_external_op(uuid, text, text, text) to authenticated;
grant execute on function public.add_artifact(uuid, text, text, text, text[], text) to authenticated;
grant execute on function public.submit_for_review(uuid, text, uuid[]) to authenticated;
grant execute on function public.send_agent_message(uuid, text, text, text[], text) to authenticated;
grant execute on function public.ack_stop(uuid) to authenticated;
grant execute on function public.end_run(uuid, text, text, jsonb, boolean) to authenticated;
grant execute on function public.record_cost(uuid, bigint, bigint, text, numeric) to authenticated, service_role;
grant execute on function public.close_task(uuid, text, text) to authenticated;
grant execute on function public.revoke_agent(uuid, text) to authenticated;
