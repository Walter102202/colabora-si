-- 0042 · Voice: what the server knows about a voice note. The audio itself is never stored.
--
-- A clip passes through the voice-transcribe Edge Function, the only place that holds the provider key. Before any cost,
-- voice_reserve checks who is asking and the limits. voice_complete and voice_fail are service-role only, so neither a
-- person nor an agent can state what a clip cost. The transcript goes to its owner: in the app it waits in the composer
-- for them to correct and send; on a channel the runtime relays it. Either way it ends as an agent_messages row.
--
-- A clip's cost goes to the monthly budget of the platform agent as one closed run per person and month. Every budget
-- check sums agent_runs and agent_runs.task_id is not null, so that one ledger task on the person's notes page adds
-- voice to every check at once. It is never claimed and carries no text. voice_clips outlives it: the quota and the
-- budget check below keep counting a clip whose ledger went away with a page deleted for good.

alter table public.agent_tasks drop constraint agent_tasks_request_kind_check;
alter table public.agent_tasks add constraint agent_tasks_request_kind_check
  check (request_kind in ('fill','rewrite','lesson','source_check','assist','voice'));

alter table public.model_prices add column usd_per_minute numeric;
insert into public.model_prices (model, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok, effective_from, source, usd_per_minute)
values ('muse-voice-transcribe-1.0', 0, 0, null, date '2026-10-30', 'provider list price: USD 0.18 per hour of audio', 0.003)
on conflict (model) do update set usd_per_minute = excluded.usd_per_minute, source = excluded.source;

create table public.voice_clips (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  channel      text not null check (channel in ('surface','telegram','whatsapp')),
  status       text not null default 'reserved' check (status in ('reserved','transcribed','failed','expired')),
  duration_ms  int not null check (duration_ms > 0),
  bytes        int not null check (bytes > 0),
  forwarded    boolean not null default false,
  ledger_run   uuid references public.agent_runs(id) on delete set null,
  model        text not null,
  -- What the provider measured; the cost comes from here.
  audio_ms     bigint,
  cost_usd     numeric(12,6) not null default 0,
  error        text,
  message_id   uuid references public.agent_messages(id) on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index voice_clips_user_idx on public.voice_clips (workspace_id, user_id, created_at desc);
create index voice_clips_agent_idx on public.voice_clips (agent_id, created_at desc);
create index voice_clips_day_idx on public.voice_clips (created_at desc) where status in ('reserved','transcribed');

alter table public.voice_clips enable row level security;
revoke all on public.voice_clips from anon, authenticated;
grant select on public.voice_clips to authenticated;
grant all on public.voice_clips to service_role;
create policy "own voice clips" on public.voice_clips for select to authenticated
  using (user_id = (select auth.uid()) and private.is_human_member(workspace_id) and private.jwt_client_id() is null);

-- The one place that sets the limits. A clip is five minutes from the app and ten from a channel; the bytes are that much
-- WAV at 24 kHz plus room for its headers. The provider has no spending cap, so the daily total across everyone is ours.
create or replace function private.voice_limits()
returns jsonb language sql immutable set search_path = '' as $$
  select '{"min_ms":300,"max_ms":300000,"channel_max_ms":600000,"max_bytes":14500000,"channel_max_bytes":29000000,"clips_per_hour":30,"ms_per_day":1800000,"global_ms_per_day":18000000,"reservation_minutes":5}'::jsonb;
$$;
revoke all on function private.voice_limits() from public, anon, authenticated;

create or replace function private.voice_cost(p_ms bigint, p_rate numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(floor(greatest(p_ms, 0) / 1000.0) * coalesce(p_rate, 0) / 60, 6);
$$;
revoke all on function private.voice_cost(bigint, numeric) from public, anon, authenticated;

-- The person's closed ledger run of this month, created at their first clip. Runs under voice_reserve's lock and as its
-- caller: a page is stamped with the caller's principal, which the service role does not have.
create or replace function private.voice_ledger_run(p_ws uuid, p_user uuid, p_agent uuid, p_model text, p_lang text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_run uuid; v_task uuid := gen_random_uuid();
begin
  select r.id into v_run from public.agent_runs r join public.agent_tasks t on t.id = r.task_id
   where t.workspace_id = p_ws and t.request_kind = 'voice' and t.owner_user_id = p_user and r.agent_id = p_agent
     and r.started_at >= date_trunc('month', now())
   order by r.started_at desc limit 1;
  if v_run is not null then return v_run; end if;
  -- No delegate: the task is a line in a ledger and never shows up in the agent's list.
  insert into public.agent_tasks (id, workspace_id, context_id, row_page_id, title, owner_user_id, state, acceptance,
                                  brief_version, created_by, created_by_type, request_kind, request, closed_at)
  values (v_task, p_ws, v_task, private.ensure_note_page(p_ws, p_user, p_lang), 'Voice transcription', p_user, 'done', 'accepted',
          1, p_agent, 'agent', 'voice', '{}', now());
  insert into public.agent_runs (workspace_id, task_id, agent_id, harness, brief_version, status, model, cost_kind, ended_at)
  values (p_ws, v_task, p_agent, 'voice-transcribe', 1, 'completed', p_model, 'measured', now())
  returning id into v_run;
  return v_run;
end $$;
revoke all on function private.voice_ledger_run(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- Says whether this clip may reach the model, before any cost. Called by the Edge Function with the caller's own token.
-- The duration comes from the WAV the function measured. A caller who lies here reserves a clip and reaches no model.
-- From the app the caller is the person. From a channel it is the platform agent, for the person of that chat.
create or replace function public.voice_reserve(p_workspace_id uuid, p_duration_ms int, p_bytes int, p_channel text default 'surface',
  p_chat_id text default null, p_forwarded boolean default false, p_lang text default 'es', p_message_id bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_agent public.agents%rowtype; v_user uuid; v_ws uuid := p_workspace_id; v_id uuid;
        l jsonb := private.voice_limits(); v_rate numeric; v_spent numeric; v_open numeric; v_clip uuid;
        v_model constant text := 'muse-voice-transcribe-1.0';
begin
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if p_channel = 'surface' then
    if private.principal_type() <> 'human' or v_uid is null then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
    if not private.is_human_member(v_ws) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
    v_agent := private.platform_agent(v_ws);
    if v_agent.id is null then raise exception using errcode = 'PT409', message = 'no_platform_agent'; end if;
    v_user := v_uid;
  else
    v_id := private.current_agent_id();
    if v_id is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    select * into v_agent from public.agents where id = v_id;
    v_ws := coalesce(v_ws, v_agent.workspace_id);
    if not v_agent.is_platform or v_agent.workspace_id is distinct from v_ws then raise exception using errcode = 'PT403', message = 'platform_only'; end if;
    v_user := private.channel_person(v_agent, p_channel, p_chat_id);
    if v_user is null then raise exception using errcode = 'PT403', message = 'not_linked'; end if;
    -- A channel delivers again after a restart. The same voice note is not paid for twice.
    if p_message_id is not null and exists (select 1 from public.agent_messages where workspace_id = v_ws and user_id = v_user
        and channel = p_channel and external_id = p_chat_id || ':' || p_message_id::text) then
      return jsonb_build_object('duplicate', true);
    end if;
  end if;
  perform private.check_rate(v_agent.id);
  if coalesce(p_duration_ms, 0) < (l->>'min_ms')::int then raise exception using errcode = 'PT422', message = 'voice_too_short'; end if;
  if p_duration_ms > (l->>case when p_channel = 'surface' then 'max_ms' else 'channel_max_ms' end)::int then raise exception using errcode = 'PT413', message = 'voice_too_long'; end if;
  if coalesce(p_bytes, 0) <= 0 or p_bytes > (l->>case when p_channel = 'surface' then 'max_bytes' else 'channel_max_bytes' end)::int then raise exception using errcode = 'PT413', message = 'voice_too_large'; end if;

  -- One at a time, so two clips cannot both pass the same remaining budget or the same daily total.
  perform pg_advisory_xact_lock(hashtextextended('voice-budget', 0));
  update public.voice_clips set status = 'expired', finished_at = now(), error = 'no_answer'
   where status = 'reserved' and created_at < now() - make_interval(mins => (l->>'reservation_minutes')::int);
  if (select count(*) from public.voice_clips where workspace_id = v_ws and user_id = v_user
       and status in ('reserved','transcribed') and created_at > now() - interval '1 hour') >= (l->>'clips_per_hour')::int
     or (select coalesce(sum(duration_ms), 0) from public.voice_clips where workspace_id = v_ws and user_id = v_user
       and status in ('reserved','transcribed') and created_at > now() - interval '1 day') + p_duration_ms > (l->>'ms_per_day')::bigint
     or (select coalesce(sum(duration_ms), 0) from public.voice_clips
       where status in ('reserved','transcribed') and created_at > now() - interval '1 day') + p_duration_ms > (l->>'global_ms_per_day')::bigint then
    raise exception using errcode = 'PT429', message = 'voice_quota', detail = '{"retry_after_s":3600}';
  end if;
  if v_agent.monthly_budget_usd is not null then
    select usd_per_minute into v_rate from public.model_prices where model = v_model;
    select coalesce(sum(cost_usd), 0) into v_spent from public.agent_runs
     where agent_id = v_agent.id and started_at >= date_trunc('month', now());
    select coalesce(sum(cost_usd) filter (where ledger_run is null), 0) + coalesce(sum(private.voice_cost(duration_ms, v_rate)) filter (where status = 'reserved'), 0)
      into v_open from public.voice_clips where agent_id = v_agent.id and created_at >= date_trunc('month', now());
    if v_spent + v_open + private.voice_cost(p_duration_ms, v_rate) > v_agent.monthly_budget_usd then
      raise exception using errcode = 'PT402', message = 'budget_exceeded',
        detail = jsonb_build_object('spent_usd', v_spent + v_open, 'budget_usd', v_agent.monthly_budget_usd)::text;
    end if;
  end if;
  insert into public.voice_clips (workspace_id, user_id, agent_id, channel, duration_ms, bytes, forwarded, ledger_run, model)
  values (v_ws, v_user, v_agent.id, p_channel, p_duration_ms, p_bytes, coalesce(p_forwarded, false),
          private.voice_ledger_run(v_ws, v_user, v_agent.id, v_model, case when p_lang = 'en' then 'en' else 'es' end), v_model)
  returning id into v_clip;
  return jsonb_build_object('clip_id', v_clip);
end $$;
revoke all on function public.voice_reserve(uuid, int, int, text, text, boolean, text, bigint) from public, anon;
grant execute on function public.voice_reserve(uuid, int, int, text, text, boolean, text, bigint) to authenticated;

-- The provider answered. Records the minutes it measured as cost. Only the Edge Function reaches this. Idempotent.
create or replace function public.voice_complete(p_clip_id uuid, p_audio_ms bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.voice_clips%rowtype; v_rate numeric; v_cost numeric; v_ms bigint;
begin
  select * into v_c from public.voice_clips where id = p_clip_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if v_c.status <> 'reserved' then return jsonb_build_object('status', v_c.status, 'cost_usd', v_c.cost_usd); end if;
  select usd_per_minute into v_rate from public.model_prices where model = v_c.model;
  v_ms := coalesce(p_audio_ms, v_c.duration_ms);
  v_cost := private.voice_cost(v_ms, v_rate);
  update public.voice_clips set status = 'transcribed', audio_ms = v_ms, cost_usd = v_cost, finished_at = now() where id = v_c.id;
  if v_c.ledger_run is not null then perform private.record_cost_core(v_c.ledger_run, 0, 0, v_c.model, v_cost); end if;
  return jsonb_build_object('status', 'transcribed', 'cost_usd', v_cost);
end $$;
revoke all on function public.voice_complete(uuid, bigint) from public, anon, authenticated;
grant execute on function public.voice_complete(uuid, bigint) to service_role;

-- The provider did not answer: the reservation ends and nothing is charged.
create or replace function public.voice_fail(p_clip_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  update public.voice_clips set status = 'failed', error = left(p_code, 80), finished_at = now()
   where id = p_clip_id and status = 'reserved' returning status into v_status;
  return jsonb_build_object('status', coalesce(v_status, 'unchanged'));
end $$;
revoke all on function public.voice_fail(uuid, text) from public, anon, authenticated;
grant execute on function public.voice_fail(uuid, text) to service_role;

-- A voice message names a clip of its own person, once. The channel's forwarded mark on the clip wins over the message.
create or replace function private.bind_voice_clip(p_clip uuid, p_msg public.agent_messages)
returns public.agent_messages language plpgsql security definer set search_path = '' as $$
declare v_c public.voice_clips%rowtype; v_m public.agent_messages%rowtype := p_msg;
begin
  if p_clip is null then return v_m; end if;
  update public.voice_clips set message_id = p_msg.id
   where id = p_clip and workspace_id = p_msg.workspace_id and user_id = p_msg.user_id and status = 'transcribed' and message_id is null
  returning * into v_c;
  if v_c.id is null then raise exception using errcode = 'PT422', message = 'voice_clip_not_ready'; end if;
  if v_c.forwarded and not p_msg.forwarded then
    update public.agent_messages set forwarded = true where id = p_msg.id returning * into v_m;
  end if;
  return v_m;
end $$;
revoke all on function private.bind_voice_clip(uuid, public.agent_messages) from public, anon, authenticated;
