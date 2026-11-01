-- Starting over is one new row: nothing is deleted, and a message still waiting for its answer stays in the conversation.
create index agent_messages_reset_idx on public.agent_messages (workspace_id, user_id, seq desc)
  where kind = 'system' and outcome->>'kind' = 'conversation_reset';

-- Where a person's current conversation starts. 0 until they start over.
create or replace function private.thread_start(p_ws uuid, p_user uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select coalesce((m.outcome->>'from_seq')::bigint, m.seq) from public.agent_messages m
     where m.workspace_id = p_ws and m.user_id = p_user and m.kind = 'system' and m.outcome->>'kind' = 'conversation_reset'
     order by m.seq desc limit 1), 0);
$$;
revoke all on function private.thread_start(uuid, uuid) from public, anon, authenticated;

create or replace function public.start_new_conversation(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_start bigint; v_pending bigint; v_id uuid;
begin
  if private.principal_type() <> 'human' or v_uid is null then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if not private.is_human_member(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  -- Two tabs pressing at once make one cut.
  perform pg_advisory_xact_lock(hashtextextended('conversation:' || p_workspace_id::text || ':' || v_uid::text, 0));
  select coalesce(max(m.seq), 0) into v_start from public.agent_messages m
   where m.workspace_id = p_workspace_id and m.user_id = v_uid
     and m.kind = 'system' and m.outcome->>'kind' = 'conversation_reset';
  if not exists (select 1 from public.agent_messages m
     where m.workspace_id = p_workspace_id and m.user_id = v_uid and m.seq > v_start
       and (m.kind = 'system' and m.outcome->>'kind' = 'conversation_reset') is not true) then
    return jsonb_build_object('reset', false);
  end if;
  select min(m.seq) into v_pending from public.agent_messages m
   where m.workspace_id = p_workspace_id and m.user_id = v_uid and m.direction = 'in' and m.needs_reply;
  insert into public.agent_messages (workspace_id, user_id, agent_id, direction, channel, kind, body, outcome)
  values (p_workspace_id, v_uid, (private.platform_agent(p_workspace_id)).id, 'out', 'surface', 'system', 'New conversation',
          jsonb_strip_nulls(jsonb_build_object('kind', 'conversation_reset', 'from_seq', v_pending)))
  returning id into v_id;
  return jsonb_build_object('reset', true, 'message_id', v_id);
end $$;
revoke all on function public.start_new_conversation(uuid) from public, anon;
grant execute on function public.start_new_conversation(uuid) to authenticated;

create or replace function public.assist_request_context(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_t public.agent_tasks%rowtype; v_items jsonb; v_through bigint; v_last public.agent_messages%rowtype; v_page jsonb; v_selection text; v_waiting jsonb; v_start bigint;
begin
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_t from public.agent_tasks
   where id = p_task_id and request_kind = 'assist' and delegate_agent_id = v_agent and active_run_id is not null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  v_start := private.thread_start(v_t.workspace_id, v_t.owner_user_id);
  select max(seq) into v_through from public.agent_messages
   where workspace_id = v_t.workspace_id and user_id = v_t.owner_user_id and direction = 'in' and needs_reply;
  select coalesce(jsonb_agg(x.m order by x.seq), '[]'::jsonb), max(x.seq) filter (where (x.m->>'waiting')::boolean)
    into v_items, v_through from (
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
       and (a.seq >= v_start or a.needs_reply)
       and (a.created_at > now() - interval '1 day' or a.needs_reply)
     order by a.needs_reply desc, case when a.needs_reply then a.seq end asc, a.seq desc limit 20) x(seq, m);
  select * into v_last from public.agent_messages where workspace_id = v_t.workspace_id
    and user_id = v_t.owner_user_id and direction = 'in' and needs_reply and seq <= v_through order by seq desc limit 1;
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
  return jsonb_build_object('running_work', private.person_running_work(v_t.workspace_id, v_t.owner_user_id), 'page', v_page, 'selection', v_selection, 'waiting_on_you', v_waiting,
    'agent_proposal_message_id', case when v_last.channel='surface' and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'proposal_message_id', case when v_page is not null and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;

create or replace function private.note_target(p_msg public.agent_messages, p_cmd jsonb, p_context jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_quote text := nullif(btrim(coalesce(p_context->>'quote_text', '')), ''); v_sel text := nullif(btrim(coalesce(p_context#>>'{selection,text}', '')), '');
        v_page text; v_ws uuid; v_prev public.agent_messages%rowtype; v_title text;
begin
  if (p_context->>'quote_missing')::boolean is true then return jsonb_build_object('problem', 'no_target'); end if;
  if p_context ? 'quote_message_id' then
    select body into v_quote from public.agent_messages
     where id = (p_context->>'quote_message_id')::uuid and workspace_id = p_msg.workspace_id and user_id = p_msg.user_id;
  end if;
  if v_quote is not null and v_sel is not null then return jsonb_build_object('problem', 'ambiguous'); end if;
  if v_quote is not null then return jsonb_build_object('text', left(v_quote, 20000), 'source', jsonb_build_object('kind', 'quote')); end if;
  if v_sel is not null then
    v_page := p_context#>>'{selection,page_id}';
    select workspace_id into v_ws from public.pages where id = v_page and deleted_at is null;
    if v_ws is distinct from p_msg.workspace_id or not private.can_read_page(v_page, v_ws) then return jsonb_build_object('problem', 'no_target'); end if;
    return jsonb_build_object('text', left(v_sel, 20000), 'source', jsonb_build_object('kind', 'selection', 'page_id', v_page));
  end if;
  if p_cmd->>'target' = 'page' then
    v_page := p_context->>'page_id';
    select workspace_id, coalesce(nullif(data->>'title', ''), 'Untitled') into v_ws, v_title from public.pages where id = v_page and deleted_at is null;
    if v_page is null or v_ws is distinct from p_msg.workspace_id or not private.can_read_page(v_page, v_ws) then return jsonb_build_object('problem', 'no_target'); end if;
    return jsonb_build_object('page_id', v_page, 'text', v_title, 'source', jsonb_build_object('kind', 'page', 'page_id', v_page));
  end if;
  select * into v_prev from public.agent_messages
   where workspace_id = p_msg.workspace_id and user_id = p_msg.user_id and seq < p_msg.seq and kind <> 'system'
     and seq >= private.thread_start(p_msg.workspace_id, p_msg.user_id)
     and created_at > p_msg.created_at - interval '30 minutes'
     and coalesce(intent->>'kind', '') <> 'save'
   order by seq desc limit 1;
  if v_prev.id is null then return jsonb_build_object('problem', 'no_target'); end if;
  return jsonb_build_object('text', v_prev.body, 'source', jsonb_build_object(
    'kind', case when v_prev.direction = 'out' then 'reply' when v_prev.kind = 'voice' then 'voice' else 'message' end,
    'message_id', v_prev.id, 'forwarded', v_prev.forwarded));
end $$;

create or replace function private.store_person_message(p_ws uuid, p_user uuid, p_agent uuid, p_channel text, p_external text, p_body text,
  p_kind text, p_forwarded boolean, p_pasted boolean, p_clip uuid, p_context jsonb, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.agent_messages%rowtype; v_old public.agent_messages%rowtype; v_outcome jsonb; v_reply text;
begin
  if p_body is null or btrim(p_body) = '' or char_length(p_body) > 20000 or p_kind is null or p_kind not in ('text','voice') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'body';
  end if;
  -- Allocate the message sequence only after any concurrent cut has committed.
  perform pg_advisory_xact_lock(hashtextextended('conversation:' || p_ws::text || ':' || p_user::text, 0));
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
