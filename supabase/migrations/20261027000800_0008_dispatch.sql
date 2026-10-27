-- 0008_dispatch: the agent_events outbox feeds a pgmq queue (agent_dispatch) that the agent-dispatch Edge
-- Function drains with service_role RPCs (§IV.7.4, §IV.10.2, D18). Pull agents (agents.delivery = 'pull') get
-- nothing pushed: their wait_for_my_tasks / list_my_tasks calls mark the events delivered.
-- pgmq is optional at migration time: without it events still land in agent_events and pull keeps working.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    create extension if not exists pgmq;
  end if;
  if exists (select 1 from pg_extension where extname = 'pgmq') then
    perform pgmq.create('agent_dispatch');
  end if;
end $$;

create or replace function private.has_pgmq()
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from pg_extension where extname = 'pgmq');
$$;

-- ============ producer ============

-- Before insert: collapse task.feedback for the same task within 30 s into the pending event (comment debounce),
-- and never queue task.start while a dependency is still open (release_dependents queues it later).
create or replace function private.agent_events_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_pending public.agent_events%rowtype;
begin
  if new.type = 'task.feedback' then
    select * into v_pending from public.agent_events
     where task_id = new.task_id and agent_id = new.agent_id and type = 'task.feedback' and status = 'queued'
       and created_at > now() - interval '30 seconds'
     order by created_at desc limit 1 for update;
    if found then
      update public.agent_events
         set payload = v_pending.payload || new.payload || jsonb_build_object(
               'text', concat_ws(E'\n\n', nullif(v_pending.payload->>'text', ''), nullif(new.payload->>'text', '')),
               'collapsed', coalesce((v_pending.payload->>'collapsed')::int, 1) + 1)
       where event_id = v_pending.event_id;
      return null;
    end if;
  elsif new.type = 'task.start' then
    if exists (select 1 from public.agent_tasks t join public.agent_tasks x on x.id = any (t.depends_on_task_ids)
                where t.id = new.task_id and x.state <> 'done') then
      return null;
    end if;
  end if;
  return new;
end $$;
create trigger agent_events_10_producer before insert on public.agent_events
  for each row execute function private.agent_events_before_insert();

-- After insert: one queue message per event, carrying only the event id.
create or replace function private.agent_events_enqueue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.has_pgmq() then
    execute 'select pgmq.send($1, $2)' using 'agent_dispatch', jsonb_build_object('event_id', new.event_id);
  end if;
  return new;
end $$;
create trigger agent_events_20_enqueue after insert on public.agent_events
  for each row execute function private.agent_events_enqueue();

revoke execute on function private.has_pgmq() from public;
revoke execute on function private.agent_events_before_insert() from public;
revoke execute on function private.agent_events_enqueue() from public;

-- ============ consumer RPCs (service_role only) ============

-- Secrets an adapter needs for one agent (webhook HMAC, provider keys).
create or replace function public.agent_dispatch_config(p_agent_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.name, s.value), '{}'::jsonb) from private.agent_secrets s where s.agent_id = p_agent_id;
$$;

-- Reads up to p_batch messages (hidden for p_vt seconds) joined with their event, agent and secrets.
create or replace function public.dispatch_dequeue(p_batch int default 20, p_vt int default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg record; v_e public.agent_events%rowtype; v_a public.agents%rowtype; v_out jsonb := '[]';
begin
  if not private.has_pgmq() then return v_out; end if;
  for v_msg in execute 'select msg_id, read_ct, message from pgmq.read($1, $2, $3)'
                 using 'agent_dispatch', greatest(coalesce(p_vt, 60), 1), least(greatest(coalesce(p_batch, 20), 1), 100) loop
    select * into v_e from public.agent_events where event_id = (v_msg.message->>'event_id')::uuid for update;
    if not found or v_e.status not in ('queued','leased') then
      execute 'select pgmq.archive($1, $2)' using 'agent_dispatch', v_msg.msg_id;   -- event gone or already settled
      continue;
    end if;
    select * into v_a from public.agents where id = v_e.agent_id;
    update public.agent_events set status = 'leased', lease_until = now() + make_interval(secs => coalesce(p_vt, 60)),
           attempt = greatest(attempt, v_msg.read_ct - 1)
     where event_id = v_e.event_id returning * into v_e;
    v_out := v_out || jsonb_build_object(
      'msg_id', v_msg.msg_id, 'read_ct', v_msg.read_ct, 'event', to_jsonb(v_e),
      'agent', jsonb_build_object('id', v_a.id, 'workspace_id', v_a.workspace_id, 'kind', v_a.kind, 'delivery', v_a.delivery,
                                  'status', v_a.status, 'capabilities', v_a.capabilities, 'connection', v_a.connection),
      'secrets', public.agent_dispatch_config(v_a.id));
  end loop;
  return v_out;
end $$;

-- Settles one delivery attempt. ok: delete the message, event delivered. Failure: back off (60 s * 2^attempt)
-- or, when not retryable or after 10 attempts, archive it, mark the event failed and tell the task owner.
create or replace function public.dispatch_ack(p_msg_id bigint, p_event_id uuid, p_ok boolean, p_error text default null,
  p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_e public.agent_events%rowtype; v_t public.agent_tasks%rowtype; v_attempt int;
begin
  select * into v_e from public.agent_events where event_id = p_event_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if p_ok then
    if private.has_pgmq() and p_msg_id is not null then execute 'select pgmq.delete($1, $2)' using 'agent_dispatch', p_msg_id; end if;
    update public.agent_events set status = 'delivered', delivered_at = now(), lease_until = null, last_error = null
     where event_id = v_e.event_id;
    return jsonb_build_object('status', 'delivered');
  end if;

  v_attempt := v_e.attempt + 1;
  if not coalesce(p_retryable, true) or v_attempt >= 10 then
    if private.has_pgmq() and p_msg_id is not null then execute 'select pgmq.archive($1, $2)' using 'agent_dispatch', p_msg_id; end if;
    update public.agent_events set status = 'failed', attempt = v_attempt, last_error = p_error, lease_until = null
     where event_id = v_e.event_id;
    select * into v_t from public.agent_tasks where id = v_e.task_id;
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
    values (v_e.workspace_id, v_t.owner_user_id, 'task_failed', v_t.row_page_id, v_t.id, v_e.agent_id, 'system',
            jsonb_build_object('reason', 'dispatch_failed', 'event_type', v_e.type, 'error', left(coalesce(p_error, ''), 280)));
    return jsonb_build_object('status', 'failed');
  end if;
  if private.has_pgmq() and p_msg_id is not null then
    execute 'select pgmq.set_vt($1, $2, $3)' using 'agent_dispatch', p_msg_id, (60 * power(2, least(v_attempt, 8)))::int;
  end if;
  update public.agent_events set status = 'queued', attempt = v_attempt, last_error = p_error,
         lease_until = now() + make_interval(secs => 60 * power(2, least(v_attempt, 8)))
   where event_id = v_e.event_id;
  return jsonb_build_object('status', 'queued', 'attempt', v_attempt);
end $$;

-- ============ pull adapter ============

-- The calling agent saw its pending events (wait_for_my_tasks / list_my_tasks): mark them delivered and drop
-- their queue messages. Null ids = every pending event of the agent. Returns the delivered events.
create or replace function public.mark_events_delivered(p_event_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_out jsonb;
begin
  v_agent := private.task_actor_agent_id();
  if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
  perform private.check_rate(v_agent);
  with done as (
    update public.agent_events set status = 'delivered', delivered_at = now(), lease_until = null
     where agent_id = v_agent and status in ('queued','leased') and (p_event_ids is null or event_id = any (p_event_ids))
    returning event_id, task_id, run_id, type, payload, seq, created_at
  )
  select coalesce(jsonb_agg(to_jsonb(done) order by created_at), '[]'::jsonb) into v_out from done;
  if private.has_pgmq() and jsonb_array_length(v_out) > 0 then
    execute 'select count(pgmq.delete($1, q.msg_id)) from pgmq.q_agent_dispatch q
              where (q.message->>''event_id'') in (select e->>''event_id'' from jsonb_array_elements($2) e)'
      using 'agent_dispatch', v_out;
  end if;
  return v_out;
end $$;

-- ============ tick (pg_cron + pg_net) ============

-- Wakes the agent-dispatch Edge Function when something is waiting. URL and secret come from Vault
-- (project_url, dispatch_cron_secret); without them, or without pg_net, the tick does nothing.
create or replace function private.dispatch_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  if not exists (select 1 from public.agent_events where status = 'queued' and (lease_until is null or lease_until < now())) then return; end if;
  if to_regclass('vault.decrypted_secrets') is null or not exists (select 1 from pg_extension where extname = 'pg_net') then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'dispatch_cron_secret';
  if v_url is null or v_secret is null then return; end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 30000)'
    using v_url || '/functions/v1/agent-dispatch',
          jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret),
          jsonb_build_object('invoked_at', now());
end $$;

revoke all on function public.agent_dispatch_config(uuid) from public, anon, authenticated;
revoke all on function public.dispatch_dequeue(int, int) from public, anon, authenticated;
revoke all on function public.dispatch_ack(bigint, uuid, boolean, text, boolean) from public, anon, authenticated;
revoke all on function public.mark_events_delivered(uuid[]) from public, anon;
revoke execute on function private.dispatch_tick() from public;
grant execute on function public.agent_dispatch_config(uuid) to service_role;
grant execute on function public.dispatch_dequeue(int, int) to service_role;
grant execute on function public.dispatch_ack(bigint, uuid, boolean, text, boolean) to service_role;
grant execute on function public.mark_events_delivered(uuid[]) to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('agent-dispatch-tick', '10 seconds', 'select private.dispatch_tick()');
  end if;
end $$;
