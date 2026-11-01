-- Pending reviews are person-authorized data, including when Trama is the caller.
create or replace function private.person_to_review(p_ws uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with lessons as materialized (
    select l.id, left(l.body, 160) as text, t.title as task, l.created_at,
           case when t.id is null then '/' else '/p/' || t.row_page_id || '?task=' || t.id::text end as path
      from public.lessons l left join public.agent_tasks t on t.id = l.source_task_id and t.workspace_id = p_ws
     where l.workspace_id = p_ws and l.status = 'proposed'
       and exists (select 1 from public.workspace_members m
                    where m.workspace_id = p_ws and m.user_id = p_user and m.role in ('owner','editor'))
       and (l.scope_page_id is null or private.person_reads_page(l.scope_page_id, p_ws, p_user))
       and (l.source_task_id is null or private.person_reads_page(t.row_page_id, p_ws, p_user))
  ), differences as materialized (
    select d.id, p.title as page, left(d.summary, 160) as text, '/p/' || p.id as path, d.created_at
      from public.page_discrepancies d join public.pages p on p.id = d.page_id and p.workspace_id = p_ws
     where d.workspace_id = p_ws and d.status = 'open'
       and private.is_workspace_member_user(p_ws, p_user)
       and private.person_reads_page(d.page_id, p_ws, p_user)
  )
  select jsonb_build_object(
    'lessons', coalesce((select jsonb_agg(to_jsonb(l) - 'created_at' order by l.created_at, l.id)
                          from (select * from lessons order by created_at, id limit 5) l), '[]'::jsonb),
    'lessons_total', (select count(*) from lessons),
    'differences', coalesce((select jsonb_agg(to_jsonb(d) - 'created_at' order by d.created_at, d.id)
                              from (select * from differences order by created_at, id limit 5) d), '[]'::jsonb),
    'differences_total', (select count(*) from differences));
$$;
revoke all on function private.person_to_review(uuid, uuid) from public, anon, authenticated;

-- The same pending rows reach Home and Trama through browser subscriptions. Filter them at RLS.
alter policy "members read lessons" on public.lessons using (
  private.is_human_member(workspace_id) and (status <> 'proposed' or (
    private.is_human_editor(workspace_id)
    and (scope_page_id is null or private.can_read_page(scope_page_id, workspace_id))
    and (source_task_id is null or exists (
      select 1 from public.agent_tasks t where t.id = source_task_id and t.workspace_id = lessons.workspace_id
        and private.can_read_page(t.row_page_id, t.workspace_id))))));
alter policy "members read page discrepancies" on public.page_discrepancies using (
  private.is_human_member(workspace_id) and private.can_read_page(page_id, workspace_id));

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
  return jsonb_build_object('to_review', private.person_to_review(v_t.workspace_id, v_t.owner_user_id), 'running_work', private.person_running_work(v_t.workspace_id, v_t.owner_user_id), 'page', v_page, 'selection', v_selection, 'waiting_on_you', v_waiting,
    'agent_proposal_message_id', case when v_last.channel='surface' and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'proposal_message_id', case when v_page is not null and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;
