-- Approve exactly the work summary shown to the person, once.
create or replace function public.reply_person_message(p_run_id uuid, p_text text, p_through_seq bigint, p_usage jsonb, p_propose_message_id uuid, p_propose_agent jsonb, p_work_summary text)
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
      if p_work_summary is not null and char_length(btrim(p_work_summary)) not between 1 and 600 then
        raise exception using errcode='PT400', message='invalid_input', detail='work_summary';
      end if;
      select * into v_proposal from public.agent_messages m where m.id = p_propose_message_id
        and m.workspace_id = v_t.workspace_id and m.user_id = v_t.owner_user_id and m.direction = 'in'
        and m.channel = 'surface' and m.needs_reply and m.seq <= p_through_seq and not m.forwarded and not m.pasted
        and private.person_reads_page(m.context->>'page_id', v_t.workspace_id, v_t.owner_user_id);
      if found then
        v_outcome := jsonb_strip_nulls(jsonb_build_object('kind','work_proposed',
          'page_id',v_proposal.context->>'page_id','message_id',v_proposal.id,'agent_id',v_r.agent_id,
          'page_title',left(coalesce((select title from public.pages where id=v_proposal.context->>'page_id'),''),200),
          'summary',btrim(p_work_summary)));
      end if;
    elsif jsonb_typeof(p_propose_agent)='object'
      and char_length(btrim(coalesce(p_propose_agent->>'name',''))) between 1 and 80
      and p_propose_agent->>'role' in ('worker','lead')
      and p_propose_agent->>'harness' in ('claude-code','codex','muse-code','cursor','gemini-cli','antigravity','hermes','openclaw') then
      select * into v_proposal from public.agent_messages m where m.id::text=p_propose_agent->>'message_id'
        and m.workspace_id=v_t.workspace_id and m.user_id=v_t.owner_user_id and m.direction='in'
        and m.channel='surface' and m.needs_reply and m.seq<=p_through_seq and not m.forwarded and not m.pasted;
      if found then v_outcome:=jsonb_build_object('kind','agent_proposed','name',btrim(p_propose_agent->>'name'),
        'harness',p_propose_agent->>'harness','role',p_propose_agent->>'role','message_id',v_proposal.id); end if;
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
revoke all on function public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb,text) from public,anon;
grant execute on function public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb,text) to authenticated;

-- Existing clients keep their exact signatures during a staged rollout.
create or replace function public.reply_person_message(p_run_id uuid,p_text text,p_through_seq bigint,p_usage jsonb,p_propose_message_id uuid,p_propose_agent jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select public.reply_person_message(p_run_id,p_text,p_through_seq,p_usage,p_propose_message_id,p_propose_agent,null);
$$;

create or replace function public.start_proposed_work(p_message_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.agent_messages%rowtype; v_objective text; v_task jsonb;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into m from public.agent_messages proposal where id=p_message_id and user_id=auth.uid()
    and private.is_human_member(proposal.workspace_id) and direction='out' and outcome->>'kind' in ('work_proposed','work_started','work_declined') for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if m.outcome->>'kind'='work_started' then
    return jsonb_build_object('task_id',m.outcome->>'task_id','page_id',m.outcome->>'page_id','already_started',true);
  end if;
  if m.outcome->>'kind'='work_declined' then raise exception using errcode='PT409',message='already_settled'; end if;
  v_objective := m.outcome->>'summary';
  if v_objective is null then
    select body into v_objective from public.agent_messages where id=(m.outcome->>'message_id')::uuid
      and user_id=m.user_id and direction='in' and not pasted and not forwarded;
  end if;
  if btrim(coalesce(v_objective,''))='' then raise exception using errcode='PT422',message='no_objective'; end if;
  v_task := public.create_agent_task(p_row_page_id := m.outcome->>'page_id',
    p_brief := jsonb_build_object('objective',v_objective),
    p_delegate_agent_id := coalesce((m.outcome->>'agent_id')::uuid,m.agent_id),
    p_idempotency_key := 'proposal:' || (m.outcome->>'message_id'));
  update public.agent_messages set outcome=outcome||jsonb_build_object('kind','work_started','task_id',v_task->>'task_id') where id=m.id;
  return jsonb_build_object('task_id',v_task->>'task_id','page_id',m.outcome->>'page_id');
end $$;
revoke all on function public.start_proposed_work(uuid) from public,anon;
grant execute on function public.start_proposed_work(uuid) to authenticated;

create or replace function public.decline_proposed_work(p_message_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.agent_messages%rowtype;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into m from public.agent_messages proposal where id=p_message_id and user_id=auth.uid()
    and private.is_human_member(proposal.workspace_id) and direction='out' and outcome->>'kind' in ('work_proposed','work_started','work_declined') for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if m.outcome->>'kind'<>'work_proposed' then raise exception using errcode='PT409',message='already_settled'; end if;
  update public.agent_messages set outcome=outcome||'{"kind":"work_declined"}'::jsonb where id=m.id;
  return jsonb_build_object('declined',true);
end $$;
revoke all on function public.decline_proposed_work(uuid) from public,anon;
grant execute on function public.decline_proposed_work(uuid) to authenticated;

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

  if private.principal_type()='human' and p_signal in ('continue','feedback')
    and v_t.state in ('ready_for_review','done') and btrim(coalesce(p_body,''))='' then
    raise exception using errcode='PT400',message='message_required';
  end if;

  if v_t.request_kind is not null and v_t.state in ('done','failed','cancelled') then
    raise exception using errcode = 'PT409', message = 'task_closed';
  end if;

  -- Reopening a closed task is a decision of a person; a Lead writing to its closed subtask gets task_closed.
  if private.is_agent() and v_t.state in ('done','failed','cancelled') then
    raise exception using errcode = 'PT409', message = 'task_closed';
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
    elsif v_t.state = 'input_required' and v_t.active_run_id is null and not private.is_agent() then
      update public.agent_tasks set state='queued', waiting_on=null, updated_at=now() where id=v_t.id;
    end if;
    if v_t.active_run_id is not null then
      v_delivery := 'queued_for_run';
    elsif v_t.state = 'input_required' and private.is_agent() then
      v_delivery := 'waiting_on_human';
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
revoke all on function public.send_agent_message(uuid, text, text, text[], text) from public, anon;
grant execute on function public.send_agent_message(uuid, text, text, text[], text) to authenticated;
