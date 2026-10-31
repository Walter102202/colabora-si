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
  select * into v_r from public.agent_runs where id = p_run_id for update;
  if not found then return false; end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  if v_r.status not in ('running','waiting') or v_r.stop_requested_at is not null or v_r.stale_at is null
     or v_t.active_run_id is distinct from v_r.id or v_t.state <> 'working'
     or private.task_waits_on_human(v_t.id)
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
declare v_stale int; v_cancelled int; v_expired int; v_receipts int; v_released int;
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

  update public.agent_runs r set stale_at = now()
    where r.status in ('running','waiting') and r.stale_at is null and r.last_signal_at < now() - interval '30 minutes'
      and not exists (
        select 1 from public.agent_tasks t
         where t.id = r.waiting_on_task_id
           and t.state in ('queued','working','input_required','ready_for_review'));
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

  -- A silent run past its lease loses the task.
  select count(*) filter (where private.release_expired_run(x.id)) into v_released
    from (select r.id from public.agent_runs r join public.agent_tasks t on t.active_run_id = r.id
           where r.status in ('running','waiting') and r.stale_at is not null and r.stop_requested_at is null and t.state = 'working'
             and r.last_signal_at < now() - make_interval(mins => private.run_lease_minutes(t.id))
           order by r.last_signal_at limit 100) x;

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

  return jsonb_build_object('stale', v_stale, 'cancelled', v_cancelled, 'released', v_released, 'approvals_expired', v_expired, 'receipts_deleted', v_receipts);
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
