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
