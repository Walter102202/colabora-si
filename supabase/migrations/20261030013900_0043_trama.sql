-- 0043: Trama identity, person-authorized page context and proposals that require a human click.

alter table public.agent_messages add column context jsonb not null default '{}'::jsonb;

create or replace function public.ensure_platform_agent(p_workspace_id uuid, p_created_by uuid, p_auth_user_id uuid, p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_a public.agents%rowtype; v_id uuid;
begin
  select owner_id into v_owner from public.workspaces where id = p_workspace_id;
  if v_owner is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  -- Only the workspace owner (workspaces.owner_id) enables it: the row is sponsored by v_owner, so nobody else may create it.
  if p_created_by <> v_owner then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  select * into v_a from public.agents where workspace_id = p_workspace_id and is_platform and revoked_at is null;
  if found then
    return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id, 'created', false);
  end if;
  if p_auth_user_id is null then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'auth_user_id is required'; end if;
  begin
    insert into public.agents (id, workspace_id, auth_user_id, name, kind, delivery, role, sponsor_user_id, monthly_budget_usd,
                               capabilities, connection, created_by, is_platform)
    values (coalesce(p_id, gen_random_uuid()), p_workspace_id, p_auth_user_id, 'Trama', 'managed', 'pull', 'lead', v_owner, 20,
            '{"start":true,"continue":true,"cancel":true,"approval":true,"cost":true}'::jsonb,
            '{"harness":"agent","model":"muse-spark-1.3","platform":true}'::jsonb, p_created_by, true)
    returning id into v_id;
  exception when unique_violation then
    -- The owner pressed the button twice at once: the other insert won. Any other unique violation (auth_user_id, 0002:10) is re-raised.
    select * into v_a from public.agents where workspace_id = p_workspace_id and is_platform and revoked_at is null;
    if v_a.id is null then raise; end if;
    return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id, 'created', false);
  end;
  perform private.audit(p_workspace_id, 'agent.create', jsonb_build_object('agent_id', v_id, 'created_by', p_created_by, 'platform', true));
  return jsonb_build_object('agent_id', v_id, 'auth_user_id', p_auth_user_id, 'created', true);
end $$;
revoke all on function public.ensure_platform_agent(uuid, uuid, uuid, uuid) from public, anon, authenticated;
update public.agents set name = 'Trama' where is_platform and revoked_at is null and name = 'Colabora';

-- Check the person explicitly; the executing agent's grants never authorize this context.
create or replace function private.person_reads_page(p_page text, p_ws uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pages p where p.id = p_page and p.workspace_id = p_ws
    and p.deleted_at is null and not coalesce((p.data->>'isDeleted')::boolean, false)
    and (private.is_workspace_member_user(p_ws, p_user) or exists (
      select 1 from public.page_shares s where s.page_id = p.id and s.user_id = p_user and s.level in ('view','comment','edit')))
    and not exists (select 1 from public.private_pages x where x.page_id = p.id and x.owner_user_id <> p_user));
$$;
revoke all on function private.person_reads_page(text, uuid, uuid) from public, anon, authenticated;

create or replace function private.store_person_message(p_ws uuid, p_user uuid, p_agent uuid, p_channel text, p_external text, p_body text,
  p_kind text, p_forwarded boolean, p_pasted boolean, p_clip uuid, p_context jsonb, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.agent_messages%rowtype; v_old public.agent_messages%rowtype; v_outcome jsonb; v_reply text;
begin
  if p_body is null or btrim(p_body) = '' or char_length(p_body) > 20000 or p_kind is null or p_kind not in ('text','voice') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'body';
  end if;
  insert into public.agent_messages (workspace_id, user_id, agent_id, direction, channel, kind, body, forwarded, pasted, external_id, context)
  values (p_ws, p_user, p_agent, 'in', p_channel, p_kind, p_body, coalesce(p_forwarded, false), coalesce(p_pasted, false), p_external, coalesce(p_context, '{}'::jsonb))
  on conflict (workspace_id, user_id, channel, external_id) where external_id is not null do nothing
  returning * into v_msg;
  if v_msg.id is null then
    select * into v_old from public.agent_messages
     where workspace_id = p_ws and user_id = p_user and channel = p_channel and external_id = p_external;
    return jsonb_build_object('message_id', v_old.id, 'duplicate', true, 'outcome', v_old.outcome);
  end if;
  v_msg := private.bind_voice_clip(p_clip, v_msg);
  v_outcome := private.handle_person_message(v_msg, p_context, p_tz);
  select body into v_reply from public.agent_messages where reply_to_id = v_msg.id and direction = 'out' order by seq desc limit 1;
  return jsonb_strip_nulls(jsonb_build_object('message_id', v_msg.id, 'duplicate', false, 'outcome', v_outcome, 'reply', v_reply));
end $$;

create or replace function public.assist_request_context(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_t public.agent_tasks%rowtype; v_items jsonb; v_through bigint; v_last public.agent_messages%rowtype; v_page jsonb; v_selection text; v_waiting jsonb;
begin
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_t from public.agent_tasks
   where id = p_task_id and request_kind = 'assist' and delegate_agent_id = v_agent and active_run_id is not null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select max(seq) into v_through from public.agent_messages
   where workspace_id = v_t.workspace_id and user_id = v_t.owner_user_id and direction = 'in' and needs_reply;
  select coalesce(jsonb_agg(x.m order by x.seq), '[]'::jsonb) into v_items from (
    select a.seq, jsonb_build_object('id', a.id, 'from', case when a.direction = 'in' then 'person' else 'agent' end, 'voice', a.kind = 'voice',
             'forwarded', a.forwarded, 'pasted', a.pasted, 'text', left(a.body, 4000), 'at', a.created_at, 'waiting', a.needs_reply)
           || case when a.needs_reply and a.intent->>'kind' = 'save' and not exists (select 1 from public.saved_notes n where n.message_id = a.id)
                then jsonb_build_object('asked_to_save', true, 'save', jsonb_strip_nulls(jsonb_build_object(
                  'preview', left(a.intent#>>'{resolved,text}', 500),
                  'source', a.intent#>>'{resolved,source,kind}',
                  'problem', a.intent#>>'{resolved,problem}',
                  'needs_text', case when a.intent->'resolved' ? 'compose' then true end)))
                else '{}'::jsonb end as m
      from public.agent_messages a
     where a.workspace_id = v_t.workspace_id and a.user_id = v_t.owner_user_id and a.kind <> 'system'
       and (a.created_at > now() - interval '1 day' or a.needs_reply)
     order by a.seq desc limit 20) x(seq, m);
  select * into v_last from public.agent_messages where workspace_id = v_t.workspace_id
    and user_id = v_t.owner_user_id and direction = 'in' and needs_reply order by seq desc limit 1;
  if private.person_reads_page(v_last.context->>'page_id', v_t.workspace_id, v_t.owner_user_id) then
    select jsonb_build_object('id', p.id, 'title', p.data->>'title', 'text', left(private.page_text(p.data), 6000))
      into v_page from public.pages p where p.id = v_last.context->>'page_id';
  end if;
  if private.person_reads_page(v_last.context#>>'{selection,page_id}', v_t.workspace_id, v_t.owner_user_id) then
    v_selection := left(v_last.context#>>'{selection,text}', 2000);
  end if;
  select coalesce(jsonb_agg(x.title), '[]'::jsonb) into v_waiting from (
    select t.title from public.agent_tasks t where t.workspace_id = v_t.workspace_id and t.owner_user_id = v_t.owner_user_id
      and t.state = 'input_required' and (t.waiting_on = 'human' or t.waiting_on is null)
      and private.person_reads_page(t.row_page_id, v_t.workspace_id, v_t.owner_user_id)
      order by t.updated_at desc limit 10) x;
  return jsonb_build_object('page', v_page, 'selection', v_selection, 'waiting_on_you', v_waiting,
    'proposal_message_id', case when v_page is not null and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;

create or replace function public.reply_person_message(p_run_id uuid, p_text text, p_through_seq bigint, p_usage jsonb, p_propose_message_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_last public.agent_messages%rowtype; v_m public.agent_messages%rowtype;
        v_text text := btrim(coalesce(p_text, '')); v_notice text; v_page text; v_reply uuid; v_proposal public.agent_messages%rowtype; v_outcome jsonb := '{"kind":"reply"}'::jsonb;
begin
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  v_r := private.own_run(p_run_id);
  if v_r.stop_requested_at is not null then raise exception using errcode = 'PT409', message = 'stop_requested'; end if;
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id;
  if v_t.request_kind is distinct from 'assist' then raise exception using errcode = 'PT422', message = 'not_a_request_run'; end if;
  if v_text = '' or char_length(v_text) > 4000 then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'text'; end if;
  select * into v_last from public.agent_messages
   where workspace_id = v_t.workspace_id and user_id = v_t.owner_user_id and direction = 'in' and needs_reply and seq <= p_through_seq
   order by seq desc limit 1 for update;
  if v_last.id is not null then
    if p_propose_message_id is not null then
      select * into v_proposal from public.agent_messages m where m.id = p_propose_message_id
        and m.workspace_id = v_t.workspace_id and m.user_id = v_t.owner_user_id and m.direction = 'in'
        and m.channel = 'surface' and m.needs_reply and m.seq <= p_through_seq and not m.forwarded and not m.pasted
        and private.person_reads_page(m.context->>'page_id', v_t.workspace_id, v_t.owner_user_id);
      if found then v_outcome := jsonb_build_object('kind','work_proposed','page_id',v_proposal.context->>'page_id','message_id',v_proposal.id); end if;
    end if;
    insert into public.agent_messages (workspace_id, user_id, agent_id, direction, channel, kind, body, reply_to_id, outcome)
    values (v_t.workspace_id, v_t.owner_user_id, v_r.agent_id, 'out', v_last.channel, 'text', v_text, v_last.id, v_outcome) returning id into v_reply;
    select string_agg(s.body, E'\n' order by s.seq), (array_agg(s.outcome->>'page_id' order by s.seq desc))[1] into v_notice, v_page
      from public.agent_messages s join public.agent_messages m on m.id = s.reply_to_id
     where m.workspace_id = v_t.workspace_id and m.user_id = v_t.owner_user_id and m.direction = 'in' and m.needs_reply and m.seq <= p_through_seq
       and s.kind = 'system' and s.outcome->>'kind' = 'note_saved';
    if v_last.channel = 'telegram' then
      update public.agent_messages set outcome = outcome || jsonb_strip_nulls(jsonb_build_object(
        'delivery_pending', true, 'chat_id', split_part(v_last.external_id, ':', 1), 'note_page_id', v_page,
        'delivery_text', case when v_notice is null then v_text else v_text || E'\n\n' || v_notice end)) where id = v_reply;
    end if;
    update public.agent_messages set needs_reply = false
     where workspace_id = v_t.workspace_id and user_id = v_t.owner_user_id and direction = 'in' and needs_reply and seq <= p_through_seq;
  end if;
  perform private.finish_request(v_r, 'assist', 'Answered the person.', p_usage);
  -- A message that arrived while the model was thinking gets its own turn.
  select * into v_m from public.agent_messages
   where workspace_id = v_t.workspace_id and user_id = v_t.owner_user_id and direction = 'in' and needs_reply order by seq desc limit 1;
  if v_m.id is not null then perform private.queue_assist(v_m); end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'channel', v_last.channel, 'message_id', v_reply,
    'chat_id', case when v_last.channel = 'surface' then null else split_part(v_last.external_id, ':', 1) end,
    'note_page_id', v_page,
    'text', case when v_last.id is null then null when v_notice is null then v_text else v_text || E'\n\n' || v_notice end));
end $$;
revoke all on function public.reply_person_message(uuid, text, bigint, jsonb, uuid) from public, anon;
grant execute on function public.reply_person_message(uuid, text, bigint, jsonb, uuid) to authenticated;

-- Preserve the existing four-argument contract for clients and channel delivery.
create or replace function public.reply_person_message(p_run_id uuid, p_text text, p_through_seq bigint, p_usage jsonb default null)
returns jsonb language sql security definer set search_path = '' as $$
  select public.reply_person_message(p_run_id, p_text, p_through_seq, p_usage, null);
$$;
revoke all on function public.reply_person_message(uuid, text, bigint, jsonb) from public, anon;
grant execute on function public.reply_person_message(uuid, text, bigint, jsonb) to authenticated;
