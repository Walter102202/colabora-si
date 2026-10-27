-- 0007_derived_state: task and run state derived by triggers (§IV.5.2), outdated reviews, cost rollup,
-- brief update fan-out and the per-minute housekeeping job. No agent writes agent_tasks.state directly.

-- ============ activities drive run and task state ============

create or replace function private.on_activity_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_tasks set last_activity_at = new.created_at, updated_at = now() where id = new.task_id;
  if new.run_id is not null then
    update public.agent_runs set last_signal_at = new.created_at, stale_at = null where id = new.run_id;
  end if;
  case new.type
    when 'elicitation' then
      update public.agent_runs  set status = 'waiting' where id = new.run_id and status = 'running';
      update public.agent_tasks set state = 'input_required', waiting_on = coalesce(new.body->>'waiting_on','human')
        where id = new.task_id and state in ('working');
    when 'error' then
      if coalesce((new.body->>'recoverable')::boolean, true) = false then
        update public.agent_runs set status = 'error', ended_at = now(), error_message = new.body->>'message'
          where id = new.run_id and status in ('running','waiting');
        if coalesce((new.body->>'terminal')::boolean, false) then
          update public.agent_tasks set state = 'failed', active_run_id = null where id = new.task_id and state <> 'done';
        else
          update public.agent_tasks set state = 'queued', active_run_id = null where id = new.task_id and state = 'working';
        end if;
      end if;
    else null;
  end case;
  return new;
end $$;
create trigger agent_activities_derive after insert on public.agent_activities
  for each row execute function private.on_activity_insert();

-- ============ outdated reviews ============

-- A review goes outdated when the artifact it reviewed is superseded by a new version (add_artifact sets
-- superseded_by on the previous row after inserting the new one) or when the task brief gets a new version.
create or replace function private.outdate_reviews()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'agent_artifacts' then
    update public.agent_reviews set outdated_by = 'artifact', outdated_at = now()
      where task_id = new.task_id and outdated_by is null and artifact_id = new.id;
  elsif tg_table_name = 'task_briefs' then
    update public.agent_reviews set outdated_by = 'brief', outdated_at = now()
      where task_id = new.task_id and outdated_by is null and brief_version < new.version;
  end if;
  update public.agent_tasks t set review_state = 'outdated'
    where t.id = new.task_id and t.review_state in ('approved','changes_requested','pending')
      and exists (select 1 from public.agent_reviews r where r.task_id = t.id)
      and not exists (select 1 from public.agent_reviews r where r.task_id = t.id and r.outdated_by is null);
  return new;
end $$;
create trigger agent_artifacts_outdate_reviews after update of superseded_by on public.agent_artifacts
  for each row when (old.superseded_by is null and new.superseded_by is not null)
  execute function private.outdate_reviews();
create trigger task_briefs_outdate_reviews after insert on public.task_briefs
  for each row execute function private.outdate_reviews();

-- ============ cost rollup ============

create or replace function private.rollup_task_cost()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_tasks
     set cost_usd = (select coalesce(sum(r.cost_usd), 0) from public.agent_runs r where r.task_id = new.task_id)
   where id = new.task_id;
  return new;
end $$;
create trigger agent_runs_rollup_cost after insert or update of cost_usd on public.agent_runs
  for each row execute function private.rollup_task_cost();

-- ============ brief updates ============

-- A new brief version marks the task stale when a run executes an older version, and tells the delegate.
create or replace function private.brief_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_tasks t
     set brief_stale = exists (select 1 from public.agent_runs r
                                where r.task_id = t.id and r.status in ('running','waiting') and r.brief_version < new.brief_version)
   where t.id = new.id;
  if new.delegate_agent_id is not null then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (new.workspace_id, new.id, new.active_run_id, new.delegate_agent_id, 'brief.updated',
            jsonb_build_object('brief_version', new.brief_version, 'previous_version', old.brief_version),
            private.next_event_seq(new.id));
  end if;
  return new;
end $$;
create trigger agent_tasks_brief_updated after update of brief_version on public.agent_tasks
  for each row when (new.brief_version > old.brief_version and old.brief_version >= 1)
  execute function private.brief_updated();

revoke execute on function private.on_activity_insert() from public;
revoke execute on function private.outdate_reviews() from public;
revoke execute on function private.rollup_task_cost() from public;
revoke execute on function private.brief_updated() from public;

-- ============ housekeeping (pg_cron, every minute) ============

create or replace function private.agent_housekeeping()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_stale int; v_cancelled int; v_expired int; v_receipts int;
begin
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

  return jsonb_build_object('stale', v_stale, 'cancelled', v_cancelled, 'approvals_expired', v_expired, 'receipts_deleted', v_receipts);
end $$;
revoke execute on function private.agent_housekeeping() from public;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('agent-housekeeping', '* * * * *', 'select private.agent_housekeeping()');
  end if;
end $$;
