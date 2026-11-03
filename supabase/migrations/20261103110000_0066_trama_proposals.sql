-- Proposal validation always uses the person's access, never Trama's grants.
create or replace function private.person_job_board(p_page text,p_ws uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.pages p where p.id=p_page and p.workspace_id=p_ws and p.deleted_at is null
    and private.person_reads_page(p.id,p_ws,p_user)
    and not exists(select 1 from public.private_pages x where x.page_id=p.id)
    and exists(select 1 from jsonb_array_elements(coalesce(p.data#>'{database,properties}','[]')) x where x->>'type'='agentStatus')
    and (exists(select 1 from public.workspaces w where w.id=p_ws and w.owner_id=p_user)
      or exists(select 1 from public.workspace_members m where m.workspace_id=p_ws and m.user_id=p_user and m.role in ('owner','editor'))
      or exists(select 1 from public.page_shares x where x.page_id=p.id and x.user_id=p_user and x.level='edit')));
$$;
revoke all on function private.person_job_board(text,uuid,uuid) from public,anon,authenticated;

create or replace function private.validate_proposed_job(p_job jsonb,p_ws uuid,p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.agents%rowtype; lead jsonb; workers jsonb:='[]'; item jsonb; ids text[]:='{}'; field text;
begin
  if jsonb_typeof(p_job) is distinct from 'object' or not private.person_job_board(p_job->>'board_id',p_ws,p_user) then
    raise exception using errcode='PT422',message='invalid_job',detail='board_id';
  end if;
  if jsonb_typeof(p_job->'title') is distinct from 'string' or char_length(btrim(p_job->>'title')) not between 1 and 120 then
    raise exception using errcode='PT422',message='invalid_job',detail='title';
  end if;
  if jsonb_typeof(p_job->'worker_agent_ids') is distinct from 'array' or jsonb_array_length(p_job->'worker_agent_ids')>4 then
    raise exception using errcode='PT422',message='invalid_job',detail='worker_agent_ids';
  end if;
  for item in select value from jsonb_array_elements(jsonb_build_array(p_job->'lead_agent_id')||(p_job->'worker_agent_ids')) loop
    field:=case when lead is null then 'lead_agent_id' else 'worker_agent_ids' end;
    select * into a from public.agents where id::text=item#>>'{}' and workspace_id=p_ws
      and status='enabled' and revoked_at is null and not is_platform
      and exists(select 1 from public.agent_connections c where c.agent_id=agents.id and c.verified_at is not null);
    if not found or a.id::text=any(ids) or (lead is null and a.role<>'lead') then
      raise exception using errcode='PT422',message='invalid_job',detail=field;
    end if;
    ids:=array_append(ids,a.id::text);
    if lead is null then lead:=jsonb_build_object('id',a.id,'name',a.name);
    else workers:=workers||jsonb_build_object('id',a.id,'name',a.name); end if;
  end loop;
  if lead is null then raise exception using errcode='PT422',message='invalid_job',detail='lead_agent_id'; end if;
  return jsonb_build_object('board_id',p_job->>'board_id','board_title',(select title from public.pages where id=p_job->>'board_id'),
    'title',btrim(p_job->>'title'),'lead',lead,'workers',workers);
end $$;
revoke all on function private.validate_proposed_job(jsonb,uuid,uuid) from public,anon,authenticated;

-- Replace the undeployed seven-argument draft with one extensible proposal payload.
drop function if exists public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb,text);
-- Approve exactly the work summary shown to the person, once.
create or replace function public.reply_person_message(p_run_id uuid, p_text text, p_through_seq bigint, p_usage jsonb, p_propose_message_id uuid, p_propose_agent jsonb, p_proposal jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_last public.agent_messages%rowtype; v_m public.agent_messages%rowtype;
        v_text text := btrim(coalesce(p_text, '')); v_notice text; v_page text; v_reply uuid; v_proposal public.agent_messages%rowtype; v_outcome jsonb := '{"kind":"reply"}'::jsonb; v_work_summary text:=p_proposal->>'summary'; v_job jsonb; v_message_task public.agent_tasks%rowtype;
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
      if v_work_summary is not null and char_length(btrim(v_work_summary)) not between 1 and 600 then
        raise exception using errcode='PT400', message='invalid_input', detail='work_summary';
      end if;
      select * into v_proposal from public.agent_messages m where m.id = p_propose_message_id
        and m.workspace_id = v_t.workspace_id and m.user_id = v_t.owner_user_id and m.direction = 'in'
        and m.channel = 'surface' and m.needs_reply and m.seq <= p_through_seq and not m.forwarded and not m.pasted
        and (p_proposal ? 'job' or p_proposal ? 'message' or private.person_reads_page(m.context->>'page_id', v_t.workspace_id, v_t.owner_user_id));
      if found then
        if p_proposal ? 'message' then
          if p_proposal ? 'job' or jsonb_typeof(p_proposal#>'{message,text}') is distinct from 'string'
            or char_length(p_proposal#>>'{message,text}') not between 1 and 1000 or btrim(p_proposal#>>'{message,text}')='' then
            raise exception using errcode='PT422',message='invalid_message',detail='text';
          end if;
          select * into v_message_task from public.agent_tasks t where t.id::text=p_proposal#>>'{message,task_id}'
            and t.workspace_id=v_t.workspace_id and t.request_kind is null and t.state not in ('done','failed','cancelled')
            and private.person_reads_page(t.row_page_id,v_t.workspace_id,v_t.owner_user_id);
          if not found then raise exception using errcode='PT422',message='invalid_message',detail='task_id'; end if;
          v_outcome:=jsonb_build_object('kind','message_proposed','task_id',v_message_task.id,'page_id',v_message_task.row_page_id,
            'task_title',v_message_task.title,'agent_name',coalesce((select name from public.agents where id=v_message_task.delegate_agent_id),'Agent'),
            'text',p_proposal#>>'{message,text}');
        else
        if p_proposal ? 'job'  then
          if nullif(btrim(v_work_summary),'') is null then raise exception using errcode='PT400',message='invalid_input',detail='work_summary'; end if;
          v_job:=private.validate_proposed_job(p_proposal->'job',v_t.workspace_id,v_t.owner_user_id);
        end if;
        v_outcome := jsonb_strip_nulls(jsonb_build_object('kind','work_proposed',
          'page_id',v_proposal.context->>'page_id','message_id',v_proposal.id,'agent_id',v_r.agent_id,
          'page_title',left(coalesce((select title from public.pages where id=v_proposal.context->>'page_id'),''),200),
          'summary',btrim(v_work_summary),'job',v_job));
        if v_job is not null then v_outcome:=v_outcome||jsonb_build_object('page_id',v_job->>'board_id','page_title',v_job->>'board_title'); end if;
        end if;
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
revoke all on function public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb,jsonb) from public,anon;
grant execute on function public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb,jsonb) to authenticated;

-- Existing clients keep their exact signatures during a staged rollout.
create or replace function public.reply_person_message(p_run_id uuid,p_text text,p_through_seq bigint,p_usage jsonb,p_propose_message_id uuid,p_propose_agent jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select public.reply_person_message(p_run_id,p_text,p_through_seq,p_usage,p_propose_message_id,p_propose_agent,null::jsonb);
$$;

create or replace function public.start_proposed_work(p_message_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.agent_messages%rowtype; v_objective text; v_task jsonb; v_job jsonb; v_page text; v_lead uuid; v_workers uuid[]; v_row jsonb;
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
  v_page:=m.outcome->>'page_id';
  v_lead:=coalesce((m.outcome->>'agent_id')::uuid,m.agent_id);
  if m.outcome ? 'job' then
    v_job:=private.validate_proposed_job(jsonb_build_object('board_id',m.outcome#>>'{job,board_id}','title',m.outcome#>>'{job,title}',
      'lead_agent_id',m.outcome#>>'{job,lead,id}','worker_agent_ids',(select coalesce(jsonb_agg(x->>'id'),'[]') from jsonb_array_elements(m.outcome#>'{job,workers}') x)),m.workspace_id,m.user_id);
    v_lead:=(v_job#>>'{lead,id}')::uuid;
    select coalesce(array_agg((x->>'id')::uuid),'{}') into v_workers from jsonb_array_elements(v_job->'workers') x;
    v_row:=public.add_rows(jsonb_build_object('database_id',v_job->>'board_id','rows',jsonb_build_array(jsonb_build_object('cells',jsonb_build_object('title',jsonb_build_object('text',v_job->>'title'))))),
      'proposal-row:'||(m.outcome->>'message_id'));
    v_page:=v_row#>>'{rows,0,page_id}';
  end if;
  v_task := public.create_agent_task(p_row_page_id := v_page,
    p_brief := jsonb_build_object('objective',v_objective), p_delegate_agent_id := v_lead,
    p_idempotency_key := 'proposal:' || (m.outcome->>'message_id'));
  if v_job is not null then perform public.assign_job(v_page,v_lead,v_workers); end if;
  update public.agent_messages set outcome=outcome||jsonb_build_object('kind','work_started','task_id',v_task->>'task_id','page_id',v_page) where id=m.id;
  return jsonb_build_object('task_id',v_task->>'task_id','page_id',v_page);
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
    and private.is_human_member(proposal.workspace_id) and direction='out' and outcome->>'kind' in ('work_proposed','work_started','work_declined','message_proposed','message_sent') for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if m.outcome->>'kind' not in ('work_proposed','message_proposed') then raise exception using errcode='PT409',message='already_settled'; end if;
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
      if exists(select 1 from public.agents where id=v_t.delegate_agent_id and not is_platform) then
        insert into public.agent_events(workspace_id,task_id,run_id,agent_id,type,payload,seq)
        values(v_t.workspace_id,v_t.id,v_t.active_run_id,v_t.delegate_agent_id,'task.message',
          jsonb_build_object('text',p_body,'signal',p_signal,'source',v_source,'from',jsonb_build_object('type',v_author_type,
            'name',case when v_author_type='agent' then (select name from public.agents where id=v_author)
              else coalesce((select nullif(raw_user_meta_data->>'full_name','') from auth.users where id=v_author),'Person') end)),private.next_event_seq(v_t.id));
      end if;
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

create or replace function public.assist_request_context(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_agent uuid := private.current_agent_id(); v_t public.agent_tasks%rowtype; v_items jsonb; v_through bigint; v_last public.agent_messages%rowtype; v_page jsonb; v_selection text; v_waiting jsonb; v_start bigint; v_agents jsonb; v_boards jsonb; v_active jsonb;
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
  select coalesce(jsonb_agg(x),'[]') into v_agents from (
    select a.id,a.name,a.role,a.connection->>'harness' as harness from public.agents a
      where a.workspace_id=v_t.workspace_id and a.status='enabled' and a.revoked_at is null and not a.is_platform
        and exists(select 1 from public.agent_connections c where c.agent_id=a.id and c.verified_at is not null)
      order by a.name,a.id limit 20) x;
  select coalesce(jsonb_agg(x),'[]') into v_boards from (
    select p.id,p.title from public.pages p where private.person_job_board(p.id,v_t.workspace_id,v_t.owner_user_id)
      order by (p.id=v_last.context->>'page_id') desc nulls last,p.title,p.id limit 10) x;
  select coalesce(jsonb_agg(x),'[]') into v_active from (
    select t.id as task_id,t.title,jsonb_build_object('id',a.id,'name',a.name) as agent,t.state,
      case when private.person_reads_page(parent.row_page_id,v_t.workspace_id,v_t.owner_user_id) then parent.title end as parent_title
    from public.agent_tasks t left join public.agents a on a.id=t.delegate_agent_id left join public.agent_tasks parent on parent.id=t.parent_task_id
    where t.workspace_id=v_t.workspace_id and t.request_kind is null and t.state not in ('done','failed','cancelled')
      and private.person_reads_page(t.row_page_id,v_t.workspace_id,v_t.owner_user_id)
    order by t.updated_at desc,t.id limit 15) x;
  return jsonb_build_object('active_tasks',v_active,'agents',v_agents,'boards',v_boards,'to_review', private.person_to_review(v_t.workspace_id, v_t.owner_user_id), 'running_work', private.person_running_work(v_t.workspace_id, v_t.owner_user_id), 'page', v_page, 'selection', v_selection, 'waiting_on_you', v_waiting,
    'agent_proposal_message_id', case when v_last.channel='surface' and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'proposal_message_id', case when v_last.channel='surface' and (v_page is not null or jsonb_array_length(v_boards)>0 or jsonb_array_length(v_active)>0) and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;

-- These events notify existing sessions; never send them to a webhook that could start another run.
alter table public.agent_events drop constraint agent_events_type_check;
alter table public.agent_events add constraint agent_events_type_check check(type in
 ('task.start','task.continue','task.feedback','task.stop','approval.decided','brief.updated','task.updated','task.message','subtask.progress'));

create or replace function private.agent_events_enqueue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.type in ('task.message','subtask.progress') then return new; end if;
  if private.has_pgmq() then
    execute 'select pgmq.send($1, $2)' using 'agent_dispatch', jsonb_build_object('event_id', new.event_id);
  end if;
  return new;
end $$;

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
       and (p_event_ids is not null or not (
         type='subtask.progress' or (type='task.continue' and payload ? 'review_of')
         or (type='task.updated' and payload ?| array['environment_release','verdict','minor_findings','review_timeout'])))
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

create or replace function public.post_activity(p_run_id uuid, p_type text, p_body jsonb, p_ephemeral boolean default false,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_id uuid; v_seq bigint; v_state text; v_child public.agent_tasks%rowtype; v_parent public.agent_tasks%rowtype; v_text text;
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
  if (p_type = 'response' and p_body ? 'submit') or (p_type = 'action' and p_body->>'op' = 'revert_run') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'body';
  end if;
  if p_type = 'action' and p_body->>'op' = 'external' and not exists (
       select 1 from public.external_ops o where o.op_id = (p_body->>'external_op_id')::uuid and o.task_id = v_r.task_id) then
    raise exception using errcode = 'PT422', message = 'unknown_external_op';
  end if;

  perform set_config('app.run_id', v_r.id::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, ephemeral, author_type, author_id, idempotency_key)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), p_type, p_body, coalesce(p_ephemeral, false),
          'agent', v_r.agent_id, p_idempotency_key)
  returning id, seq into v_id, v_seq;
  v_text:=left(coalesce(p_body->>'text',p_body->>'summary',''),300);
  if not coalesce(p_ephemeral,false) and p_type in ('thought','action','response') and btrim(v_text)<>'' then
    select * into v_child from public.agent_tasks where id=v_r.task_id;
    select * into v_parent from public.agent_tasks where id=v_child.parent_task_id;
    if v_parent.id is not null and exists(select 1 from public.agents where id=v_parent.delegate_agent_id and not is_platform) then
      perform pg_advisory_xact_lock(hashtextextended('progress:'||v_child.id::text,0));
      if not exists(select 1 from public.agent_events where task_id=v_parent.id and type='subtask.progress'
        and payload->>'subtask_id'=v_child.id::text and created_at>now()-interval '2 minutes') then
        insert into public.agent_events(workspace_id,task_id,run_id,agent_id,type,payload,seq)
        values(v_parent.workspace_id,v_parent.id,v_parent.active_run_id,v_parent.delegate_agent_id,'subtask.progress',
          jsonb_build_object('subtask_id',v_child.id,'subtask_title',v_child.title,'worker_name',(select name from public.agents where id=v_r.agent_id),'text',v_text),private.next_event_seq(v_parent.id));
      end if;
    end if;
  end if;
  select state into v_state from public.agent_tasks where id = v_r.task_id;
  return jsonb_build_object('activity_id', v_id, 'seq', v_seq, 'task_state', v_state);
end $$;

-- A per-run cursor shares one delivery mark between heartbeat and passive tool notices.
alter table public.agent_runs add column if not exists prompt_delivered_seq bigint not null default 0;
create or replace function private.take_run_prompts(p_run_id uuid,p_after_seq bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.agent_runs%rowtype; v_from bigint; v_to bigint; result jsonb;
begin
  select * into r from public.agent_runs where id=p_run_id and agent_id=private.current_agent_id() for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  v_from:=greatest(r.prompt_delivered_seq,coalesce(p_after_seq,(select min(seq) from public.agent_activities where run_id=r.id),0));
  select coalesce(jsonb_agg(jsonb_build_object('seq',a.seq,'text',a.body->>'text','signal',a.body->>'signal',
    'source',a.body->>'source','author_type',a.author_type,'created_at',a.created_at,'approval_id',a.body->>'approval_id','decision',a.body->>'decision',
    'author',case when a.author_type='agent' then coalesce((select name from public.agents where id=a.author_id),'Agent') else 'Person' end) order by a.seq),'[]'),max(a.seq)
    into result,v_to from public.agent_activities a where a.task_id=r.task_id and a.type='prompt' and a.seq>v_from;
  update public.agent_runs set prompt_delivered_seq=greatest(v_from,coalesce(v_to,0)) where id=r.id;
  return result;
end $$;
revoke all on function private.take_run_prompts(uuid,bigint) from public,anon,authenticated;

create or replace function public.take_pending_messages()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_agent uuid:=private.current_agent_id(); r record; result jsonb:='[]'; prompts jsonb;
begin
  if v_agent is null then raise exception using errcode='PT403',message='agents_only'; end if;
  if exists(select 1 from public.agents where id=v_agent and is_platform) then return result; end if;
  for r in select run.id,t.title from public.agent_runs run join public.agent_tasks t on t.active_run_id=run.id
    where run.agent_id=v_agent and run.status in ('running','waiting') and private.agent_can(t.row_page_id,'read') order by run.id loop
    prompts:=private.take_run_prompts(r.id);
    select result||coalesce(jsonb_agg(p||jsonb_build_object('title',r.title)),'[]') into result from jsonb_array_elements(prompts) p;
  end loop;
  return result;
end $$;
revoke all on function public.take_pending_messages() from public,anon;
grant execute on function public.take_pending_messages() to authenticated;

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
    'pending_prompts',private.take_run_prompts(v_r.id,p_after_seq));
end $$;

create or replace function public.send_proposed_message(p_message_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.agent_messages%rowtype; t public.agent_tasks%rowtype;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into m from public.agent_messages proposal where id=p_message_id and user_id=auth.uid() and direction='out'
    and private.is_human_member(proposal.workspace_id) and outcome->>'kind' in ('message_proposed','message_sent','work_declined') for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if m.outcome->>'kind'='work_declined' then raise exception using errcode='PT409',message='already_settled'; end if;
  if m.outcome->>'kind'='message_sent' then return jsonb_build_object('task_id',m.outcome->>'task_id','page_id',m.outcome->>'page_id','already_sent',true); end if;
  select * into t from public.agent_tasks where id=(m.outcome->>'task_id')::uuid and workspace_id=m.workspace_id
    and request_kind is null and private.person_reads_page(row_page_id,m.workspace_id,m.user_id) for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if t.state in ('done','failed','cancelled') then raise exception using errcode='PT409',message='task_closed'; end if;
  perform public.send_agent_message(p_task_id:=t.id,p_body:=m.outcome->>'text',p_signal:='feedback');
  update public.agent_messages set outcome=outcome||jsonb_build_object('kind','message_sent','page_id',t.row_page_id) where id=m.id;
  return jsonb_build_object('task_id',t.id,'page_id',t.row_page_id);
end $$;
revoke all on function public.send_proposed_message(uuid) from public,anon;
grant execute on function public.send_proposed_message(uuid) to authenticated;
