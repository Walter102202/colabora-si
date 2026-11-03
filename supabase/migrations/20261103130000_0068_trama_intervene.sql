-- Person-scoped job activity for Trama. Content is data, never authorization.
create or replace function private.person_jobs(p_ws uuid, p_user uuid, p_open_page text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with visible as materialized (
    select t.* from public.agent_tasks t
    where t.workspace_id = p_ws and t.request_kind is null
      and private.person_reads_page(t.row_page_id, p_ws, p_user)
  ), jobs as (
    select t.*, coalesce(t.row_page_id = p_open_page or t.db_page_id = p_open_page
      or exists (select 1 from visible c where c.parent_task_id = t.id and c.row_page_id = p_open_page), false) as is_open,
      greatest(t.last_activity_at, (select max(c.last_activity_at) from visible c where c.parent_task_id = t.id)) as latest_at
    from visible t where t.parent_task_id is null and t.owner_user_id = p_user
      and t.state not in ('done','failed','cancelled')
    order by is_open desc, latest_at desc nulls last, t.id limit 5
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'task_id', j.id, 'title', j.title, 'url', '/p/' || j.row_page_id || '?task=' || j.id::text,
    'state', j.state, 'waiting_on', j.waiting_on, 'open', j.is_open,
    'lead', (select jsonb_build_object('id', a.id, 'name', case when a.is_platform then 'Trama' else a.name end)
      from public.agents a where a.id = j.delegate_agent_id),
    'last_activity_at', j.latest_at,
    'recent', (select coalesce(jsonb_agg(x.item order by x.created_at desc, x.seq desc, x.id), '[]'::jsonb) from (
      select act.created_at, act.seq, act.id, jsonb_build_object('at', act.created_at,
        'author', case when act.author_type = 'agent' then case when a.is_platform then 'Trama' else a.name end
          when act.author_type = 'human' then coalesce(u.raw_user_meta_data->>'full_name', 'Person') else 'System' end,
        'on', case when t.id = j.id then 'job' else t.title end,
        'text', left(coalesce(act.body->>'text', act.body->>'summary'), 240)) as item
      from public.agent_activities act join visible t on t.id = act.task_id
      left join public.agents a on act.author_type = 'agent' and a.id = act.author_id
      left join auth.users u on act.author_type = 'human' and u.id = act.author_id
      where (t.id = j.id or t.parent_task_id = j.id) and not act.ephemeral
        and act.type in ('thought','action','response','checkpoint','handover','prompt','elicitation')
        and nullif(btrim(coalesce(act.body->>'text', act.body->>'summary')), '') is not null
      order by act.created_at desc, act.seq desc, act.id limit 4
    ) x),
    'subtasks', (select coalesce(jsonb_agg(x.item order by x.last_activity_at desc nulls last, x.id), '[]'::jsonb) from (
      select c.id, c.last_activity_at, jsonb_build_object(
        'task_id', c.id, 'title', c.title, 'url', '/p/' || c.row_page_id || '?task=' || c.id::text,
        'agent', (select jsonb_build_object('id', a.id, 'name', case when a.is_platform then 'Trama' else a.name end)
          from public.agents a where a.id = c.delegate_agent_id),
        'state', c.state, 'waiting_on', c.waiting_on,
        'last', (select jsonb_build_object('at', act.created_at, 'text', left(coalesce(act.body->>'text', act.body->>'summary'), 160))
          from public.agent_activities act where act.task_id = c.id and not act.ephemeral
            and act.type in ('thought','action','response','checkpoint','handover','prompt','elicitation')
            and nullif(btrim(coalesce(act.body->>'text', act.body->>'summary')), '') is not null
          order by act.created_at desc, act.seq desc limit 1)) as item
      from visible c where c.parent_task_id = j.id
      order by c.last_activity_at desc nulls last, c.id limit 8
    ) x)
  ) order by j.is_open desc, j.latest_at desc nulls last, j.id), '[]'::jsonb) from jobs j;
$$;
revoke all on function private.person_jobs(uuid, uuid, text) from public, anon, authenticated;
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
      where a.workspace_id=v_t.workspace_id and private.agent_assignable(a.id)
      order by a.name,a.id limit 20) x;
  select coalesce(jsonb_agg(x),'[]') into v_boards from (
    select p.id,p.title from public.pages p where p.workspace_id=v_t.workspace_id and private.person_job_board(p.id,v_t.workspace_id,v_t.owner_user_id)
      order by (p.id=v_last.context->>'page_id') desc nulls last,p.title,p.id limit 10) x;
  select coalesce(jsonb_agg(x),'[]') into v_active from (
    select t.id as task_id,t.title,jsonb_build_object('id',a.id,'name',a.name) as agent,t.state,
      t.parent_task_id, t.context_id as job_task_id,
      (coalesce(a.role = 'lead', false) or exists (select 1 from public.agent_tasks c where c.parent_task_id = t.id)) as is_lead,
      case when private.person_reads_page(parent.row_page_id,v_t.workspace_id,v_t.owner_user_id) then parent.title end as parent_title
    from public.agent_tasks t left join public.agents a on a.id=t.delegate_agent_id left join public.agent_tasks parent on parent.id=t.parent_task_id
    where t.workspace_id=v_t.workspace_id and t.request_kind is null and t.state not in ('done','failed','cancelled')
      and private.person_reads_page(t.row_page_id,v_t.workspace_id,v_t.owner_user_id)
    order by t.updated_at desc,t.id limit 15) x;
  return jsonb_build_object('jobs', private.person_jobs(v_t.workspace_id, v_t.owner_user_id, v_last.context->>'page_id'),
    'last_answer_at', (select max(m.created_at) from public.agent_messages m where m.workspace_id = v_t.workspace_id
      and m.user_id = v_t.owner_user_id and m.agent_id = v_agent and m.direction = 'out' and m.kind <> 'system' and m.seq >= v_start),
    'active_tasks',v_active,'agents',v_agents,'boards',v_boards,'to_review', private.person_to_review(v_t.workspace_id, v_t.owner_user_id), 'running_work', private.person_running_work(v_t.workspace_id, v_t.owner_user_id), 'page', v_page, 'selection', v_selection, 'waiting_on_you', v_waiting,
    'agent_proposal_message_id', case when v_last.channel='surface' and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'proposal_message_id', case when v_last.channel='surface' and (v_page is not null or jsonb_array_length(v_boards)>0 or jsonb_array_length(v_active)>0) and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;
revoke all on function public.assist_request_context(uuid) from public, anon;
grant execute on function public.assist_request_context(uuid) to authenticated;

-- Private receipts connect a confirmed human message to the prompt actually delivered.
create table private.sent_person_messages (
  message_id uuid primary key references public.agent_messages(id) on delete cascade,
  task_id uuid not null,
  prompt_seq bigint not null,
  sent_at timestamptz not null default now(),
  received_at timestamptz,
  reply_activity_id uuid
);
alter table private.sent_person_messages enable row level security;
revoke all on private.sent_person_messages from public, anon, authenticated;
create index sent_person_messages_pending_idx on private.sent_person_messages(task_id) where reply_activity_id is null;

create or replace function private.send_agent_message_core(p_task_id uuid, p_body text, p_signal text,
  p_block_ids text[], p_comment_id text, p_via text, p_requirement_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_agent uuid; v_author uuid; v_author_type text; v_source text; v_delivery text;
        v_run public.agent_runs%rowtype; v_activity uuid; v_seq bigint; v_from jsonb; v_metadata jsonb := jsonb_strip_nulls(jsonb_build_object('requirement_id', p_requirement_id));
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
    v_source := case when p_via = 'Trama' then 'trama' when p_comment_id is not null then 'comment' else 'row_panel' end;
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

  v_seq := private.next_seq(v_t.id);
  v_from := jsonb_strip_nulls(jsonb_build_object('type', v_author_type,
    'name', case when v_author_type = 'agent' then (select name from public.agents where id = v_author)
      else coalesce((select nullif(raw_user_meta_data->>'full_name','') from auth.users where id = v_author), 'Person') end,
    'via', case when v_source = 'trama' then 'Trama' end));
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
          jsonb_build_object('text',p_body,'signal',p_signal,'source',v_source,'from',v_from,'prompt_seq',v_seq)||v_metadata,private.next_event_seq(v_t.id));
      end if;
    elsif v_t.state = 'input_required' and private.is_agent() then
      v_delivery := 'waiting_on_human';
    elsif exists (select 1 from public.agents a where a.id=v_t.delegate_agent_id and coalesce((a.capabilities->>'continue')::boolean, false)) then
      insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
      values (v_t.workspace_id, v_t.id, null, v_t.delegate_agent_id,
              case p_signal when 'continue' then 'task.continue' else 'task.feedback' end,
              jsonb_build_object('text', p_body, 'signal', p_signal, 'source', v_source, 'from', v_from, 'prompt_seq', v_seq)||v_metadata, private.next_event_seq(v_t.id));
      v_delivery := 'dispatched';
    else
      v_delivery := 'queued_for_next_session';
    end if;
  end if;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_t.active_run_id, v_seq, 'prompt',
          jsonb_build_object('text', coalesce(p_body, ''), 'signal', p_signal, 'source', v_source, 'comment_id', p_comment_id,
                             'block_ids', to_jsonb(coalesce(p_block_ids, '{}')))||v_metadata, v_author_type, v_author)
  returning id into v_activity;
  return jsonb_build_object('activity_id', v_activity, 'delivery', v_delivery, 'prompt_seq', v_seq);
end $$;
revoke all on function private.send_agent_message_core(uuid, text, text, text[], text, text, text) from public, anon, authenticated;

create or replace function public.send_agent_message(p_task_id uuid, p_body text, p_signal text default 'feedback',
  p_block_ids text[] default '{}', p_comment_id text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select private.send_agent_message_core(p_task_id, p_body, p_signal, p_block_ids, p_comment_id, null) - 'prompt_seq';
$$;
revoke all on function public.send_agent_message(uuid, text, text, text[], text) from public, anon;
grant execute on function public.send_agent_message(uuid, text, text, text[], text) to authenticated;

-- Replace the old overload so PostgREST resolves both defaulted and explicit calls.
drop function public.send_proposed_message(uuid);
create or replace function public.send_proposed_message(p_message_id uuid, p_add_requirement boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.agent_messages%rowtype; t public.agent_tasks%rowtype; v_result jsonb; v_page public.pages%rowtype;
  v_criteria jsonb; v_visible_criteria jsonb := '[]'; v_text text; v_requirement text; v_n int; v_block jsonb; v_after text; v_found boolean := false; v_inside boolean := false; v_ops jsonb := '[]'; v_chunk jsonb;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into m from public.agent_messages proposal where id=p_message_id and user_id=auth.uid() and direction='out'
    and private.is_human_member(proposal.workspace_id) and outcome->>'kind' in ('message_proposed','message_sent','work_declined') for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if m.outcome->>'kind'='work_declined' then raise exception using errcode='PT409',message='already_settled'; end if;
  if m.outcome->>'kind'='message_sent' then return jsonb_build_object('task_id',m.outcome->>'task_id','page_id',m.outcome->>'page_id','delivery',m.outcome->>'delivery','already_sent',true) || jsonb_strip_nulls(jsonb_build_object('requirement_id',m.outcome->>'requirement_id')); end if;
  select * into t from public.agent_tasks where id=(m.outcome->>'task_id')::uuid and workspace_id=m.workspace_id
    and request_kind is null and private.person_reads_page(row_page_id,m.workspace_id,m.user_id) for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if t.state in ('done','failed','cancelled') then raise exception using errcode='PT409',message='task_closed'; end if;
  if coalesce(p_add_requirement, false) then
    -- Lock the editable row as well as the task; all writes below commit together.
    select * into v_page from public.pages where id = t.row_page_id for update;
    perform private.pw_page(t.row_page_id);
    select done_when into v_criteria from public.task_briefs where task_id = t.id and version = t.brief_version;
    v_n := jsonb_array_length(v_criteria) + 1;
    while exists (select 1 from jsonb_array_elements(v_criteria) c where c->>'id' = 'c' || v_n::text) loop v_n := v_n + 1; end loop;
    v_requirement := 'c' || v_n::text;
    for v_block in select value from jsonb_array_elements(coalesce(v_page.data->'blocks', '[]')) loop
      if v_block->>'key' = 'brief:done_when' then
        v_found := true; v_inside := true; v_after := v_block->>'id';
      elsif v_inside then
        exit when v_block->>'key' like 'brief:%';
        v_text := btrim(private.html_to_text(v_block->>'html'));
        if v_text <> '' then v_visible_criteria := v_visible_criteria || jsonb_build_array(v_text); end if;
        v_after := v_block->>'id';
      end if;
    end loop;
    if v_found and v_visible_criteria is distinct from (select coalesce(jsonb_agg(btrim(c->>'text') order by ord), '[]')
      from jsonb_array_elements(v_criteria) with ordinality x(c,ord)) then
      raise exception using errcode='PT409',message='brief_out_of_sync',detail='Update the brief from its page before adding a criterion.';
    end if;
    if not v_found then
      v_after := v_page.data#>>'{blocks,-1,id}';
      v_block := private.render_block(jsonb_build_object('type','heading2','key','brief:done_when','spans',jsonb_build_array('Done when')));
      v_ops := v_ops || jsonb_build_object('op','insert_block','after',v_after,'block',v_block);
      v_after := v_block->>'id';
      -- A later Update brief reads these blocks, so retain every saved criterion.
      for v_block in select value from jsonb_array_elements(v_criteria) loop
        v_block := private.render_block(jsonb_build_object('type','todo','spans',jsonb_build_array(v_block->>'text'),'checked',false));
        v_ops := v_ops || jsonb_build_object('op','insert_block','after',v_after,'block',v_block);
        v_after := v_block->>'id';
      end loop;
    end if;
    v_block := private.render_block(jsonb_build_object('type','todo','spans',jsonb_build_array(m.outcome->>'text'),'checked',false));
    v_ops := v_ops || jsonb_build_object('op','insert_block','after',v_after,'block',v_block);
    perform public.update_brief(t.id, jsonb_build_object('done_when', v_criteria || jsonb_build_array(
      jsonb_build_object('id',v_requirement,'text',m.outcome->>'text','check','human'))));
    for v_chunk in select jsonb_agg(value order by ord) from jsonb_array_elements(v_ops) with ordinality x(value,ord)
      group by (ord-1)/200 order by (ord-1)/200 loop
      perform private.apply_page_ops_core(t.row_page_id, v_chunk, null);
    end loop;
  end if;
  v_result := private.send_agent_message_core(t.id, m.outcome->>'text', 'feedback', '{}', null, 'Trama', v_requirement);
  insert into private.sent_person_messages(message_id, task_id, prompt_seq) values (m.id, t.id, (v_result->>'prompt_seq')::bigint);
  update public.agent_messages set outcome=outcome||jsonb_build_object('kind','message_sent','page_id',t.row_page_id,
    'sent_at',now(),'delivery',v_result->>'delivery','prompt_seq',(v_result->>'prompt_seq')::bigint) || jsonb_strip_nulls(jsonb_build_object('requirement_id',v_requirement)) where id=m.id;
  return jsonb_build_object('task_id',t.id,'page_id',t.row_page_id,'delivery',v_result->>'delivery') || jsonb_strip_nulls(jsonb_build_object('requirement_id',v_requirement));
end $$;
revoke all on function public.send_proposed_message(uuid,boolean) from public, anon;
grant execute on function public.send_proposed_message(uuid,boolean) to authenticated;

create or replace function private.take_run_prompts(p_run_id uuid,p_after_seq bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.agent_runs%rowtype; v_from bigint; v_to bigint; result jsonb;
begin
  select * into r from public.agent_runs where id=p_run_id and agent_id=private.current_agent_id() for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  -- A caller's explicit after_seq is honoured (a loop that never shows tool text to its model must not lose prompts);
  -- without one, the shared delivery cursor makes tool notices and heartbeats deliver each prompt once.
  v_from:=case when p_after_seq is not null then p_after_seq
    else greatest(r.prompt_delivered_seq,coalesce((select min(seq) from public.agent_activities where run_id=r.id),0)) end;
  select coalesce(jsonb_agg(jsonb_build_object('seq',a.seq,'text',a.body->>'text','signal',a.body->>'signal',
    'via',case when a.body->>'source' = 'trama' then 'Trama' end,'requirement_id',a.body->>'requirement_id',
    'source',a.body->>'source','author_type',a.author_type,'created_at',a.created_at,'approval_id',a.body->>'approval_id','decision',a.body->>'decision',
    'author',case when a.author_type='agent' then coalesce((select name from public.agents where id=a.author_id),'Agent')
      else coalesce((select nullif(u.raw_user_meta_data->>'full_name','') from auth.users u where u.id=a.author_id),'Person') end) order by a.seq),'[]'),max(a.seq)
    into result,v_to from public.agent_activities a where a.task_id=r.task_id and a.type='prompt' and a.seq>v_from;
  -- Write only when the cursor moves forward: agent_runs is in the Realtime publication.
  if v_to is not null and v_to>coalesce(r.prompt_delivered_seq,0) then
    update public.agent_runs set prompt_delivered_seq=v_to where id=r.id;
  end if;
  return result;
end $$;
revoke all on function private.take_run_prompts(uuid,bigint) from public,anon,authenticated;

-- Receipt bookkeeping is best-effort: it must never abort the delivery or agent write.
create or replace function private.receive_person_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_seq bigint; v_started timestamptz; v_exact boolean := false;
begin
  if not exists (select 1 from public.agent_tasks t where t.id = new.task_id and t.delegate_agent_id = new.agent_id) then return new; end if;
  if tg_table_name = 'agent_runs' then
    if tg_op = 'INSERT' then
      if new.status not in ('running','waiting') then return new; end if;
      v_started := new.started_at;
    else
      v_seq := new.prompt_delivered_seq;
    end if;
  else
    v_seq := (new.payload->>'prompt_seq')::bigint;
    v_exact := true;
  end if;
  with received as (
    update private.sent_person_messages s set received_at = now()
    where s.task_id = new.task_id and s.reply_activity_id is null and s.received_at is null
      and exists (select 1 from public.agent_messages m join public.agent_tasks t on t.id = s.task_id
        where m.id = s.message_id and private.person_reads_page(t.row_page_id, t.workspace_id, m.user_id))
      and ((v_started is not null and s.sent_at <= v_started)
        or (v_exact and s.prompt_seq = v_seq) or (not v_exact and s.prompt_seq <= v_seq))
    returning s.message_id, s.received_at
  )
  update public.agent_messages m set outcome = m.outcome || jsonb_build_object('received_at', r.received_at)
    from received r where m.id = r.message_id;
  return new;
exception when others then
  return new;
end $$;
revoke all on function private.receive_person_message() from public, anon, authenticated;

create trigger agent_runs_person_receipt after insert or update of prompt_delivered_seq on public.agent_runs
  for each row execute function private.receive_person_message();
create trigger agent_events_person_receipt after update of status on public.agent_events
  for each row when (new.type = 'task.message' and new.status = 'delivered' and old.status is distinct from new.status)
  execute function private.receive_person_message();

create or replace function private.reply_to_person_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if new.author_type <> 'agent' or new.ephemeral or new.type not in ('response','thought')
    or nullif(btrim(new.body->>'text'), '') is null then return new; end if;
  select case when a.is_platform then 'Trama' else a.name end into v_name
    from public.agent_tasks t join public.agents a on a.id = t.delegate_agent_id
    where t.id = new.task_id and a.id = new.author_id;
  if not found then return new; end if;
  with replied as (
    update private.sent_person_messages s set reply_activity_id = new.id, received_at = coalesce(s.received_at, now())
    where s.task_id = new.task_id and s.reply_activity_id is null and s.prompt_seq < new.seq
      and exists (select 1 from public.agent_messages m join public.agent_tasks t on t.id = s.task_id
        where m.id = s.message_id and private.person_reads_page(t.row_page_id, t.workspace_id, m.user_id))
    returning s.message_id, s.received_at
  )
  update public.agent_messages m set outcome = m.outcome || jsonb_build_object('received_at', r.received_at,
    'reply', jsonb_build_object('text', left(new.body->>'text', 300), 'at', new.created_at, 'agent_name', v_name))
    from replied r where m.id = r.message_id;
  return new;
exception when others then
  return new;
end $$;
revoke all on function private.reply_to_person_message() from public, anon, authenticated;
create trigger agent_activities_person_reply after insert on public.agent_activities
  for each row when (new.type in ('response','thought') and not new.ephemeral and new.author_type = 'agent')
  execute function private.reply_to_person_message();

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
          if (p_proposal->'message') ? 'adds_requirement' and jsonb_typeof(p_proposal#>'{message,adds_requirement}') is distinct from 'boolean' then
            raise exception using errcode='PT422',message='invalid_message',detail='adds_requirement';
          end if;
          select * into v_message_task from public.agent_tasks t where t.id::text=p_proposal#>>'{message,task_id}'
            and t.workspace_id=v_t.workspace_id and t.request_kind is null and t.state not in ('done','failed','cancelled')
            and private.person_reads_page(t.row_page_id,v_t.workspace_id,v_t.owner_user_id);
          if not found then raise exception using errcode='PT422',message='invalid_message',detail='task_id'; end if;
          v_outcome:=jsonb_build_object('kind','message_proposed','task_id',v_message_task.id,'page_id',v_message_task.row_page_id,
            'task_title',v_message_task.title,'agent_name',coalesce((select name from public.agents where id=v_message_task.delegate_agent_id),'Agent'),
            'text',p_proposal#>>'{message,text}') || case when (p_proposal->'message') ? 'adds_requirement'
              then jsonb_build_object('adds_requirement',p_proposal#>'{message,adds_requirement}') else '{}'::jsonb end;
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
