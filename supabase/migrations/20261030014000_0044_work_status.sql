-- Person-scoped work status; no model or agent grant widens the person's visibility.
create or replace function private.person_running_work(p_ws uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.item order by x.updated_at desc), '[]'::jsonb) from (
    select t.updated_at, jsonb_build_object('task_id',t.id,'title',t.title,'agent',a.name,'state',t.state,
      'waiting_on',t.waiting_on,'last_activity_at',coalesce(t.last_activity_at,t.updated_at),
      'stopped',t.state='cancelled' or r.stop_requested_at is not null,
      'subtasks_done',(select count(*) from public.agent_tasks c where c.parent_task_id=t.id and c.state='done'
        and c.owner_user_id=p_user and private.person_reads_page(c.row_page_id,p_ws,p_user)),
      'subtasks_total',(select count(*) from public.agent_tasks c where c.parent_task_id=t.id
        and c.owner_user_id=p_user and private.person_reads_page(c.row_page_id,p_ws,p_user))) as item
    from public.agent_tasks t left join public.agents a on a.id=t.delegate_agent_id
      left join public.agent_runs r on r.id=t.active_run_id
    where t.workspace_id=p_ws and t.owner_user_id=p_user and t.request_kind is null and t.state <> 'done'
      and private.person_reads_page(t.row_page_id,p_ws,p_user)
    order by t.updated_at desc limit 10) x;
$$;
revoke all on function private.person_running_work(uuid,uuid) from public,anon,authenticated;

create or replace function public.person_work_status(p_workspace_id uuid default null, p_chat_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid; v_ws uuid; v_a public.agents%rowtype;
begin
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  if private.principal_type()='human' then
    v_user:=auth.uid(); v_ws:=p_workspace_id;
    if not private.is_human_member(v_ws) then raise exception using errcode='PT403',message='forbidden'; end if;
  else
    select * into v_a from public.agents where id=private.current_agent_id() and is_platform and revoked_at is null;
    if not found then raise exception using errcode='PT403',message='platform_only'; end if;
    v_user:=private.channel_person(v_a,'telegram',p_chat_id); v_ws:=v_a.workspace_id;
    if v_user is null then raise exception using errcode='PT403',message='not_linked'; end if;
  end if;
  return jsonb_build_object('running_work',private.person_running_work(v_ws,v_user));
end $$;
revoke all on function public.person_work_status(uuid,text) from public,anon;
grant execute on function public.person_work_status(uuid,text) to authenticated;

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
    'proposal_message_id', case when v_page is not null and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;
