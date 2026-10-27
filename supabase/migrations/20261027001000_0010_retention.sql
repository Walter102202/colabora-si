-- 0010_retention: daily cleanup and hourly budget rollup (§IV.11.9, §IV.10.2). The bodies live in private
-- functions so they can be called directly; pg_cron schedules them when the extension exists.

-- Activities stay append-only; the only deletes allowed are foreign-key cascades and the retention job,
-- which runs as the owner with app.retention = 'on' for its own transaction.
create or replace function private.agent_activities_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.retention', true), '') = 'on' then return old; end if;
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    if (to_jsonb(new) - 'run_id') = (to_jsonb(old) - 'run_id') then return new; end if;
  end if;
  raise exception using errcode = 'PT403', message = 'activities_immutable';
end $$;

create or replace function private.agent_retention()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_notifications int; v_receipts int; v_webhooks int; v_counters int; v_activities int; v_events int; v_tokens int;
begin
  delete from public.notifications where read_at is not null and created_at < now() - interval '90 days';
  get diagnostics v_notifications = row_count;
  delete from private.write_receipts where created_at < now() - interval '48 hours';
  get diagnostics v_receipts = row_count;
  delete from private.webhook_receipts where created_at < now() - interval '24 hours';
  get diagnostics v_webhooks = row_count;
  delete from private.rate_counters where window_start < now() - interval '1 hour';
  get diagnostics v_counters = row_count;

  perform set_config('app.retention', 'on', true);
  delete from public.agent_activities where ephemeral and created_at < now() - interval '30 days';
  get diagnostics v_activities = row_count;
  perform set_config('app.retention', '', true);

  delete from public.agent_events
   where (status in ('acked','delivered') and created_at < now() - interval '7 days')
      or (status = 'failed' and created_at < now() - interval '90 days');
  get diagnostics v_events = row_count;
  delete from public.agent_tokens where revoked_at < now() - interval '30 days';
  get diagnostics v_tokens = row_count;

  return jsonb_build_object('notifications', v_notifications, 'write_receipts', v_receipts, 'webhook_receipts', v_webhooks,
                            'rate_counters', v_counters, 'ephemeral_activities', v_activities, 'agent_events', v_events,
                            'agent_tokens', v_tokens);
end $$;

-- Month-to-date spend per agent, materialized so dashboards and budget checks need not sum runs each time.
create or replace function private.agent_budget_rollup()
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.agents a
     set connection = a.connection || jsonb_build_object(
           'spent_month', coalesce((select sum(r.cost_usd) from public.agent_runs r
                                     where r.agent_id = a.id and r.started_at >= date_trunc('month', now())), 0),
           'spent_month_at', now())
   where a.revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function private.agent_retention() from public;
revoke execute on function private.agent_budget_rollup() from public;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('agent-retention', '0 3 * * *', 'select private.agent_retention()');
    perform cron.schedule('agent-budget-rollup', '0 * * * *', 'select private.agent_budget_rollup()');
  end if;
end $$;
