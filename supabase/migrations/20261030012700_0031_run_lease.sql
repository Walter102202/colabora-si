-- 0031_run_lease: a run that stops signalling loses its task, so a dead session no longer holds it until a person steps
-- in. The task goes back to the same delegate as a handover; the old run is cancelled, which fences its late writes.

-- Minutes a run may stay silent: policies.lease_minutes of the brief (30 to 1440), 120 by default.
create or replace function private.run_lease_minutes(p_task_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(
    case when b.policies->>'lease_minutes' ~ '^[0-9]{2,4}$' and (b.policies->>'lease_minutes')::int between 30 and 1440
         then (b.policies->>'lease_minutes')::int end, 120)
    from public.agent_tasks t
    left join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version
   where t.id = p_task_id;
$$;
revoke execute on function private.run_lease_minutes(uuid) from public;

-- Everything is checked again under the locks: a signal that arrived after the scan keeps the run.
create or replace function private.release_expired_run(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype;
begin
  select * into v_r from public.agent_runs where id = p_run_id for update skip locked;
  if not found then return false; end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update skip locked;
  if not found then return false; end if;
  if v_r.status not in ('running','waiting') or v_r.stop_requested_at is not null or v_r.stale_at is null
     or v_t.active_run_id is distinct from v_r.id or v_t.state <> 'working'
     or private.task_waits_on_human(v_t.id)
     or exists(select 1 from public.agent_tasks child where child.parent_task_id=v_t.id and child.state not in ('done','failed','cancelled'))
     or v_r.last_signal_at >= now() - make_interval(mins => private.run_lease_minutes(v_t.id)) then
    return false;
  end if;
  perform private.detach_task_links(v_r.id);
  update public.agent_runs set status = 'cancelled', stop_requested_at = now(), ended_at = now(), error_message = 'lease expired'
   where id = v_r.id;
  update public.agent_tasks set active_run_id = null, state = 'queued', waiting_on = null, updated_at = now() where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'prompt',
    jsonb_build_object('signal', 'continue', 'source', 'lease', 'handover', true, 'from_run_id', v_r.id,
      'to_agent_id', v_t.delegate_agent_id, 'text', 'The last run went silent past its lease. Resume from its checkpoint.'),
    'system', v_r.agent_id);
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  values (v_t.workspace_id, v_t.id, v_r.id, v_r.agent_id, 'task.stop', jsonb_build_object('reason', 'lease'), private.next_event_seq(v_t.id));
  if exists (select 1 from public.agents where id = v_t.delegate_agent_id and capabilities->'continue' = 'true'::jsonb) then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.id, null, v_t.delegate_agent_id, 'task.continue',
      jsonb_build_object('handover', true, 'context_id', v_t.context_id, 'brief_version', v_t.brief_version,
        'from_harness', v_r.harness, 'note', 'lease expired'), private.next_event_seq(v_t.id));
  end if;
  insert into public.audit_events (workspace_id, actor_id, actor_type, run_id, action, target)
  values (v_t.workspace_id, null, 'system', v_r.id, 'task.lease_expired',
    jsonb_build_object('task_id', v_t.id, 'run_id', v_r.id, 'harness', v_r.harness));
  return true;
end $$;
revoke execute on function private.release_expired_run(uuid) from public;

-- Full copy of agent_housekeeping (0007); only the lease pass and its count are new.
create or replace function private.agent_housekeeping()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_stale int; v_cancelled int; v_expired int; v_receipts int; v_released int; v_review_timeouts int;
begin
  -- AI requests have no manual worker recovery path: expire after fifteen idle minutes.
  -- Lock runs before tasks like request writes; skip busy rows instead of racing a heartbeat/write.
  with idle_runs as materialized (
    select r.id from public.agent_runs r join public.agent_tasks t on t.active_run_id = r.id
     where t.request_kind is not null and r.status in ('running','waiting')
       and r.stop_requested_at is null and r.last_signal_at < now() - interval '15 minutes'
     for update of r skip locked
  ), candidates as materialized (
    select t.id from public.agent_tasks t left join public.agent_runs r on r.id = t.active_run_id
     where t.request_kind is not null and t.state not in ('done','failed','cancelled')
       and greatest(t.updated_at, coalesce(r.last_signal_at, t.created_at)) < now() - interval '15 minutes'
       and r.stop_requested_at is null
       and (r.id is null or r.status not in ('running','waiting') or r.id in (select id from idle_runs))
     for update of t skip locked
  ), expired_requests as (
    update public.agent_tasks t set state = 'failed', closed_at = now(), closed_by = null,
      active_run_id = null, waiting_on = null, updated_at = now()
     where t.id in (select id from candidates) returning t.id
  ), ended as (
    update public.agent_runs set status = 'error', ended_at = now(), error_message = 'AI request expired after 15 minutes without progress.'
     where task_id in (select id from expired_requests) and status in ('running','waiting') returning id
  )
  update public.agent_approvals set status = 'cancelled'
   where task_id in (select id from expired_requests) and status = 'pending';

  -- A persisted task wait is not a heartbeat. Only human input, stop and open children exempt the lease.
  with candidates as (select r.id from public.agent_runs r where r.status in ('running','waiting')
    and r.stale_at is null and r.last_signal_at<now()-interval '30 minutes' for update skip locked)
  update public.agent_runs r set stale_at=now() where r.id in (select id from candidates);
  get diagnostics v_stale = row_count;

  -- Stop without acknowledgement for 10 minutes: the run and its task are cancelled anyway (D12).
  with cancelled as (
    update public.agent_runs set status = 'cancelled', ended_at = now()
     where stop_requested_at < now() - interval '10 minutes' and stop_acked_at is null and status in ('running','waiting')
    returning id
  ), tasks as (
    update public.agent_tasks t set state = 'cancelled', active_run_id = null, waiting_on = null, updated_at = now()
      from cancelled c where t.active_run_id = c.id
    returning t.id
  )
  select count(*) into v_cancelled from cancelled;

  -- A review can close its task before the harness sends end_run.
  with finished as (select r.id,t.state from public.agent_runs r join public.agent_tasks t on t.id=r.task_id
    where r.status in ('running','waiting') and t.state in ('done','failed','cancelled') for update of r skip locked)
  update public.agent_runs r set status=case f.state when 'done' then 'completed' when 'failed' then 'error' else 'cancelled' end,
    ended_at=now() from finished f where r.id=f.id;

  -- A silent run past its lease loses the task.
  select count(*) filter (where private.release_expired_run(x.id)) into v_released
    from (select r.id from public.agent_runs r join public.agent_tasks t on t.active_run_id = r.id
           where r.status in ('running','waiting') and r.stale_at is not null and r.stop_requested_at is null and t.state = 'working'
             and r.last_signal_at < now() - make_interval(mins => private.run_lease_minutes(t.id))
           order by r.last_signal_at limit 100 for update of r skip locked) x;

  with expired as (
    update public.agent_approvals set status = 'expired' where status = 'pending' and expires_at < now()
    returning id, workspace_id, task_id
  )
  insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, approval_id, actor_type, payload)
  select e.workspace_id, t.owner_user_id, 'approval_expired', t.row_page_id, t.id, e.id, 'system', '{}'::jsonb
    from expired e join public.agent_tasks t on t.id = e.task_id;
  get diagnostics v_expired = row_count;
  update public.agent_approvals set status = 'expired' where status = 'decided' and receipt_expires_at < now();

  delete from private.write_receipts where created_at < now() - interval '48 hours';
  get diagnostics v_receipts = row_count;

  v_review_timeouts:=private.notify_review_queue_timeouts();
  return jsonb_build_object('review_timeouts',v_review_timeouts,'stale', v_stale, 'cancelled', v_cancelled, 'released', v_released, 'approvals_expired', v_expired, 'receipts_deleted', v_receipts);
end $$;

-- Full copy from 0006: an expired agent run cannot supersede the resumed session artifacts.
create or replace function public.add_artifact(p_run_id uuid, p_kind text, p_ref text, p_title text, p_satisfies text[] default '{}',
  p_content_hash text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_prev public.agent_artifacts%rowtype;
        v_id uuid := gen_random_uuid(); v_ver int := 1; v_rev bigint; v_bad text; v_author uuid; v_author_type text;
begin
  if private.is_agent() or private.linked_agent_id() is not null then
    v_r := private.own_run(p_run_id);
    if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
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


-- Shared authority check for agent commands without an explicit run argument.
create or replace function private.require_active_task(p_task_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.agent_tasks t join public.agent_runs r on r.id=t.active_run_id
    where t.id=p_task_id and t.state not in ('done','failed','cancelled') and r.agent_id=private.current_agent_id()
      and r.status in ('running','waiting') and r.stop_requested_at is null) then
    raise exception using errcode='PT422',message='run_not_active';
  end if;
end $$;
revoke all on function private.require_active_task(uuid) from public;

-- Full copy from0006: completed operations and expired runs cannot be rewritten.
create or replace function public.finish_external_op(p_op_id uuid, p_status text, p_provider_ref text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_op public.external_ops%rowtype; v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype;
begin
  select * into v_op from public.external_ops where op_id = p_op_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  v_r := private.own_run(v_op.run_id);
  if v_r.status not in ('running','waiting') or v_r.stop_requested_at is not null then
    raise exception using errcode='PT422',message='run_not_active';
  end if;
  perform private.require_active_task(v_r.task_id);
  if v_op.status not in ('pending','unknown') then raise exception using errcode='PT422',message='invalid_state'; end if;
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

-- Full copy from0009: Lead commands require its active parent run.
create or replace function public.create_subtask(p_parent_task_id uuid, p_row_page_id text, p_brief jsonb,
  p_delegate_agent_id uuid default null, p_reference_task_ids uuid[] default '{}', p_depends_on_task_ids uuid[] default '{}',
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lead uuid; v_parent public.agent_tasks%rowtype;
begin
  if not private.is_agent() or private.current_agent_id() is null then
    raise exception using errcode = 'PT403', message = 'lead_only';
  end if;
  select * into v_parent from public.agent_tasks where id = p_parent_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'parent_not_found'; end if;
  v_lead := private.lead_of(p_parent_task_id);
  if v_lead is null then raise exception using errcode = 'PT403', message = 'lead_only'; end if;
  perform private.require_active_task(v_parent.id);
  return public.create_agent_task(p_row_page_id, p_brief, p_delegate_agent_id, p_parent_task_id,
                                  p_reference_task_ids, p_depends_on_task_ids, p_idempotency_key);
end $$;

-- Full copy from0030.
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
    v_ok := private.deterministic_checks_pass(v_t.id);
  else
    v_ok := coalesce(v_policies->>'subtask_close', '') = 'lead' or private.deterministic_checks_pass(v_t.id);
  end if;
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

create or replace function private.require_task_page_run(p_page_id text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_agent uuid:=private.current_agent_id();
begin
  if v_agent is not null then
    if exists(select 1 from public.agent_tasks t where t.row_page_id=p_page_id and (t.delegate_agent_id=v_agent
      or exists(select 1 from public.agent_runs previous where previous.task_id=t.id and previous.agent_id=v_agent))
      and t.state not in ('done','failed','cancelled') and not exists(select 1 from public.agent_runs r where r.id=t.active_run_id
        and r.agent_id=v_agent and r.status in ('running','waiting') and r.stop_requested_at is null)) then
      raise exception using errcode='PT422',message='run_not_active';
    end if;
  end if;
end $$;
revoke all on function private.require_task_page_run(text) from public;

-- Full copy from0005: assigned open task pages require an active run; standalone grant-based writes remain supported.
create or replace function private.pw_page(p_page_id text)
returns public.pages language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_agent uuid;
begin
  select * into v_page from public.pages where id = p_page_id and deleted_at is null;
  if not found or v_page.data is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if coalesce((v_page.data->>'locked')::boolean, false) then
    raise exception using errcode = 'PT423', message = 'page_locked',
      detail = jsonb_build_object('locked_by', v_page.last_edited_by)::text;
  end if;
  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    perform private.require_task_page_run(p_page_id);
  end if;
  if not private.can_write_page(p_page_id, v_page.workspace_id) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  return v_page;
end $$;

-- Full copy from0025: direct child creation must not bypass the Lead command fence.
create or replace function public.create_agent_task(p_row_page_id text, p_brief jsonb, p_delegate_agent_id uuid default null,
  p_parent_task_id uuid default null, p_reference_task_ids uuid[] default '{}', p_depends_on_task_ids uuid[] default '{}',
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_page public.pages%rowtype; v_parent public.agent_tasks%rowtype;
        v_agent uuid; v_a public.agents%rowtype; v_d public.agents%rowtype; v_owner uuid; v_author uuid; v_author_type text;
        v_id uuid := gen_random_uuid(); v_ctx uuid; v_db text; v_receipt jsonb; v_spent numeric; v_max int; v_count int;
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
    select * into v_parent from public.agent_tasks where id = p_parent_task_id for update;
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

  if exists (select 1 from public.agent_tasks where row_page_id = p_row_page_id and state not in ('done','failed','cancelled')
              and request_kind is null) then
    raise exception using errcode = 'PT409', message = 'task_exists';
  end if;

  v_ctx := coalesce(v_parent.context_id, v_id);
  if exists (select 1 from unnest(coalesce(p_depends_on_task_ids, '{}')) d
              where not exists (select 1 from public.agent_tasks x where x.id = d and x.context_id = v_ctx)) then
    raise exception using errcode = 'PT422', message = 'invalid_dependency';
  end if;
  select p.id into v_db from public.pages p where p.id = v_page.parent_id and p.data ? 'database';

  if private.is_agent() and p_parent_task_id is not null then
    perform private.require_active_task(p_parent_task_id);
    select (policies->>'team_size_max')::int into v_max from public.task_briefs where task_id=v_parent.id and version=v_parent.brief_version;
    if v_max is not null and not (coalesce(p_brief->'policies','{}') ? 'review_of') then
      select count(*) into v_count from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version
        where t.parent_task_id=v_parent.id and t.state<>'cancelled' and not (b.policies ? 'review_of');
      if v_count>=v_max then raise exception using errcode='PT422',message='team_size_exceeded',detail=jsonb_build_object('max',v_max)::text; end if;
    end if;
  end if;
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

-- Full copy from0005: database edits also fence the assigned row they mutate.
create or replace function public.set_row_cells(p_db_page_id text, p_row_id text, p_cells jsonb, p_rev bigint default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_page public.pages%rowtype; v_actor uuid := (select auth.uid()); v_run uuid; v_row jsonb; v_resolved jsonb;
        v_ops jsonb := '[]'; v_res jsonb; v_res_title jsonb; v_receipt jsonb; v_prop jsonb; v_key text; v_val jsonb; v_inverse jsonb;
begin
  if p_idempotency_key is not null then
    select result into v_receipt from private.write_receipts
     where scope='set_row_cells' and key=p_idempotency_key and actor_id=v_actor;
    if found then return v_receipt; end if;
  end if;
  if jsonb_typeof(p_cells) is distinct from 'object' or p_cells = '{}'::jsonb then raise exception using errcode='PT400', message='invalid_input'; end if;

  v_page := private.pw_page(p_db_page_id);
  if not (v_page.data ? 'database') then raise exception using errcode='PT422', message='not_a_database'; end if;
  select r into v_row from jsonb_array_elements(coalesce(v_page.data->'database'->'rows','[]')) r where r->>'id' = p_row_id;
  if v_row is null then raise exception using errcode='PT404', message='row_not_found', detail=p_row_id; end if;
  perform private.require_task_page_run(v_row->>'pageId');
  v_run := private.pw_run(array[p_db_page_id, v_row->>'pageId']);

  v_resolved := private.resolve_cells(v_page.data->'database', p_cells, v_page.workspace_id);
  for v_prop in select value from jsonb_each(v_resolved->'properties') loop
    v_ops := v_ops || jsonb_build_object('op','db_prop_set','property',v_prop);
  end loop;
  for v_key, v_val in select * from jsonb_each(v_resolved->'cells') loop
    v_ops := v_ops || (jsonb_build_object('op','db_cell_set','rowId',p_row_id,'propertyId',v_key,'value',v_val)
                       || case when p_rev is not null then jsonb_build_object('rev', p_rev) else '{}'::jsonb end);
  end loop;

  if v_run is not null then perform set_config('app.run_id', v_run::text, true); end if;
  v_res := private.apply_page_ops_core(p_db_page_id, v_ops, null);
  v_inverse := v_res->'inverse';
  -- The title cell is mirrored on the row page, with its own revision.
  if v_resolved->'cells' ? 'title' and exists (select 1 from public.pages where id = v_row->>'pageId' and deleted_at is null) then
    v_res_title := private.apply_page_ops_core(v_row->>'pageId',
      jsonb_build_array(jsonb_build_object('op','set_page','patch',jsonb_build_object('title', v_resolved->'cells'->'title'))), null);
    v_inverse := v_inverse || jsonb_build_array(jsonb_build_object('page_id', v_row->>'pageId', 'ops', v_res_title->'inverse'));
  end if;

  perform private.pw_activity(v_run,
    jsonb_build_object('op','set_cells','page_id',p_db_page_id,'row_id',p_row_id,'revision',v_res->'revision',
                       'summary', 'Set ' || (select count(*) from jsonb_object_keys(v_resolved->'cells')) || ' cell(s)'),
    v_inverse);
  v_receipt := jsonb_build_object('revision', v_res->'revision',
    'rev', (select max((x->>'rev')::int) from jsonb_array_elements(v_res->'results') x));
  if p_idempotency_key is not null then
    insert into private.write_receipts (scope, key, actor_id, result) values ('set_row_cells', p_idempotency_key, v_actor, v_receipt);
  end if;
  return v_receipt;
end $$;

-- Shared handover core from0019; callers retain their distinct human/Lead authorization.
create or replace function private.release_for_handover(p_task_id uuid,p_to_agent_id uuid,p_note text,p_clear_delegate boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_r public.agent_runs%rowtype; v_from uuid;
  v_actor_type text:=case when private.is_agent() then 'agent' else 'human' end;
  v_actor uuid:=case when private.is_agent() then private.current_agent_id() else auth.uid() end;
begin
  select * into v_t from public.agent_tasks where id=p_task_id for update;
  if v_t.state not in ('queued','working','input_required') then raise exception using errcode='PT409',message='run_active'; end if;
  v_from := v_t.active_run_id;
  if v_from is not null then
    perform private.detach_task_links(v_from);
    update public.agent_runs set status = 'cancelled', stop_requested_at = coalesce(stop_requested_at, now()),
      ended_at = now(), error_message = case when v_actor_type='human' then 'released for handover by a person' else 'reassigned for handover by the Lead' end where id = v_from returning * into v_r;
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.id, v_r.id, v_r.agent_id, 'task.stop', jsonb_build_object('reason', 'handover'), private.next_event_seq(v_t.id));
  else
    -- The last run that ended, ordered by its claim activity as resume_context does (timestamps tie inside one transaction).
    select r.* into v_r from public.agent_runs r where r.task_id = v_t.id and r.status in ('completed','cancelled','error')
     order by (select min(a.seq) from public.agent_activities a where a.task_id = v_t.id and a.run_id = r.id) desc nulls last,
              r.started_at desc, r.id limit 1;
  end if;
  if p_to_agent_id is not null then
    perform private.ensure_delegate_grants(p_to_agent_id, v_t.workspace_id, v_t.row_page_id,
      (select sources from public.task_briefs where task_id = v_t.id and version = v_t.brief_version));
  end if;
  update public.agent_tasks set delegate_agent_id = case when p_clear_delegate then null else coalesce(p_to_agent_id, delegate_agent_id) end, active_run_id = null,
    state = case when private.task_waits_on_human(v_t.id) then 'input_required' else 'queued' end,
    waiting_on = case when private.task_waits_on_human(v_t.id) then 'human' end, updated_at = now()
    where id = v_t.id returning * into v_t;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'prompt',
    jsonb_build_object('signal', 'continue', 'source', 'handover', 'handover', true, 'from_run_id', v_r.id,
      'to_agent_id', v_t.delegate_agent_id, 'text', coalesce(p_note, '')), v_actor_type, v_actor);
  if exists (select 1 from public.agents where id = v_t.delegate_agent_id and capabilities->'continue' = 'true'::jsonb) then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.id, null, v_t.delegate_agent_id, 'task.continue',
      jsonb_build_object('handover', true, 'context_id', v_t.context_id, 'brief_version', v_t.brief_version,
        'from_harness', v_r.harness, 'note', left(coalesce(p_note, ''), 280)), private.next_event_seq(v_t.id));
  end if;
  perform private.audit(v_t.workspace_id, 'task.handover', jsonb_build_object('task_id', v_t.id, 'from_run_id', v_r.id, 'to_agent_id', v_t.delegate_agent_id, 'by', v_actor_type));
  return jsonb_build_object('task_state', v_t.state, 'delegate_agent_id', v_t.delegate_agent_id, 'cancelled_run_id', v_from);
end $$;
revoke all on function private.release_for_handover(uuid,uuid,text,boolean) from public;

create or replace function public.release_for_handover(p_task_id uuid, p_to_agent_id uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_r public.agent_runs%rowtype; v_from uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if v_t.state not in ('queued','working','input_required') then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  if char_length(p_note) > 4000 then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if p_to_agent_id is not null and not exists (
    select 1 from public.agents where id = p_to_agent_id and workspace_id = v_t.workspace_id and status = 'enabled' and revoked_at is null) then
    raise exception using errcode = 'PT404', message = 'delegate_not_found';
  end if;
  return private.release_for_handover(p_task_id,p_to_agent_id,p_note);
end $$;
