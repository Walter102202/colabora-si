-- Connections keep approval separate from the first successful starter-page read.
create table public.agent_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null unique references public.agents(id) on delete cascade,
  page_id text not null references public.pages(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  client_id text,
  authorization_id text,
  approved_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_connections_client_idx on public.agent_connections(workspace_id,created_by,client_id);
alter table public.agent_connections enable row level security;
create policy "members read connections" on public.agent_connections for select to authenticated
  using (private.is_human_member(workspace_id));
revoke all on public.agent_connections from public,anon,authenticated;
grant select on public.agent_connections to authenticated;

create table private.connect_claims (
  authorization_id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
revoke all on private.connect_claims from public,anon,authenticated;

create or replace function public.connect_workspaces()
returns table(id uuid,name text) language plpgsql security definer set search_path='' as $$
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  return query select w.id,w.name from public.workspaces w where private.can_edit_workspace(w.id) order by w.created_at,w.id;
end $$;
revoke all on function public.connect_workspaces() from public,anon;
grant execute on function public.connect_workspaces() to authenticated;

create or replace function public.connect_claim(p_workspace_id uuid,p_authorization_id text,p_client_id text,p_agent_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_claim private.connect_claims%rowtype; v_agent uuid;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  if not private.can_edit_workspace(p_workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  if nullif(btrim(p_authorization_id),'') is null then raise exception using errcode='PT400',message='invalid_authorization'; end if;
  perform pg_advisory_xact_lock(hashtextextended('connect-claim:'||p_authorization_id,53));
  select * into v_claim from private.connect_claims where authorization_id=p_authorization_id;
  if found then
    if v_claim.created_by<>auth.uid() or v_claim.workspace_id<>p_workspace_id then raise exception using errcode='PT403',message='forbidden'; end if;
    return v_claim.agent_id;
  end if;
  if p_client_id is null then raise exception using errcode='PT404',message='not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('connect-client:'||p_workspace_id::text||':'||auth.uid()::text||':'||p_client_id,53));
  select c.agent_id into v_agent from public.agent_connections c join public.agents a on a.id=c.agent_id
    where c.workspace_id=p_workspace_id and c.created_by=auth.uid() and c.client_id=p_client_id
      and a.revoked_at is null and a.status='enabled'
    order by c.created_at,c.id limit 1;
  v_agent:=coalesce(v_agent,p_agent_id);
  insert into private.connect_claims(authorization_id,workspace_id,agent_id,created_by)
    values(p_authorization_id,p_workspace_id,v_agent,auth.uid());
  return v_agent;
end $$;
revoke all on function public.connect_claim(uuid,text,text,uuid) from public,anon;
grant execute on function public.connect_claim(uuid,text,text,uuid) to authenticated;

create or replace function public.connect_agent_finish(p_workspace_id uuid,p_agent_id uuid,p_client_id text default null,p_authorization_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_agent public.agents%rowtype; v_page text; v_created jsonb;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  if not private.can_edit_workspace(p_workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  select * into v_agent from public.agents where id=p_agent_id and workspace_id=p_workspace_id
    and status='enabled' and revoked_at is null and not is_platform;
  if not found or not (v_agent.sponsor_user_id=auth.uid() or private.is_workspace_owner(p_workspace_id)) then
    raise exception using errcode='PT403',message='forbidden';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('connect:'||p_workspace_id::text,51));
  select p.id into v_page from public.agent_connections c join public.pages p on p.id=c.page_id
    where c.workspace_id=p_workspace_id and p.workspace_id=p_workspace_id and p.deleted_at is null
      and not exists(select 1 from public.private_pages pp where pp.page_id=p.id)
    order by c.created_at,c.id limit 1;
  if v_page is null then
    select p.id into v_page from public.pages p where p.workspace_id=p_workspace_id and p.parent_id is null
      and p.deleted_at is null and p.data->>'title'='Getting started'
      and not exists(select 1 from public.private_pages pp where pp.page_id=p.id)
      order by p.created_at,p.id limit 1;
  end if;
  if v_page is null then
    v_created:=public.create_page(jsonb_build_object('workspace_id',p_workspace_id,'parent_id',null,
      'title','Getting started','icon','👋','blocks',jsonb_build_array(
        jsonb_build_object('type','heading2','spans',jsonb_build_array('Work here with your agent')),
        jsonb_build_object('type','paragraph','spans',jsonb_build_array('This page is shared with the agents you connect. Anything you put here, they can read and change.')),
        jsonb_build_object('type','bulleted','spans',jsonb_build_array('Ask your agent to create a page here.')),
        jsonb_build_object('type','bulleted','spans',jsonb_build_array('Edit what it writes. It sees your changes.'))
      )),'connect-start:'||gen_random_uuid()::text);
    v_page:=v_created->>'id';
  end if;
  perform public.grant_agent_page(p_agent_id,v_page,array['read','write','comment'],true);
  insert into public.agent_connections(workspace_id,agent_id,page_id,created_by,client_id,authorization_id)
    values(p_workspace_id,p_agent_id,v_page,auth.uid(),p_client_id,p_authorization_id)
    on conflict(agent_id) do update set page_id=excluded.page_id,
      client_id=coalesce(excluded.client_id,agent_connections.client_id),
      authorization_id=coalesce(excluded.authorization_id,agent_connections.authorization_id),
      verified_at=case when agent_connections.page_id=excluded.page_id then agent_connections.verified_at else null end;
  return jsonb_build_object('agent_id',p_agent_id,'page_id',v_page);
end $$;
revoke all on function public.connect_agent_finish(uuid,uuid,text,text) from public,anon;
grant execute on function public.connect_agent_finish(uuid,uuid,text,text) to authenticated;

create or replace function public.connect_agent_approved(p_agent_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_agent public.agents%rowtype;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into v_agent from public.agents where id=p_agent_id and status='enabled' and revoked_at is null and not is_platform;
  if not found or not private.can_edit_workspace(v_agent.workspace_id)
    or not (v_agent.sponsor_user_id=auth.uid() or private.is_workspace_owner(v_agent.workspace_id)) then
    raise exception using errcode='PT403',message='forbidden';
  end if;
  update public.agent_connections set approved_at=now() where agent_id=p_agent_id;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
end $$;
revoke all on function public.connect_agent_approved(uuid) from public,anon;
grant execute on function public.connect_agent_approved(uuid) to authenticated;

create or replace function public.record_agent_read(p_page_id text)
returns void language plpgsql security definer set search_path='' as $$
declare v_agent uuid:=private.current_agent_id();
begin
  if v_agent is null then return; end if;
  update public.agent_connections set verified_at=now()
    where agent_id=v_agent and page_id=p_page_id and verified_at is null and private.agent_can_read(p_page_id);
end $$;
revoke all on function public.record_agent_read(text) from public,anon;
grant execute on function public.record_agent_read(text) to authenticated;

-- Trama proposes an agent
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
    'agent_proposal_message_id', case when v_last.channel='surface' and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'proposal_message_id', case when v_page is not null and not v_last.pasted and not v_last.forwarded then v_last.id end,
    'kind', 'assist', 'task_id', v_t.id, 'messages', v_items, 'through_seq', v_through);
end $$;
create or replace function public.reply_person_message(p_run_id uuid, p_text text, p_through_seq bigint, p_usage jsonb, p_propose_message_id uuid, p_propose_agent jsonb)
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
revoke all on function public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb) from public,anon;
grant execute on function public.reply_person_message(uuid,text,bigint,jsonb,uuid,jsonb) to authenticated;
create or replace function public.reply_person_message(p_run_id uuid,p_text text,p_through_seq bigint,p_usage jsonb,p_propose_message_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select public.reply_person_message(p_run_id,p_text,p_through_seq,p_usage,p_propose_message_id,null);
$$;
revoke all on function public.reply_person_message(uuid,text,bigint,jsonb,uuid) from public,anon;
grant execute on function public.reply_person_message(uuid,text,bigint,jsonb,uuid) to authenticated;

create or replace function public.settle_agent_proposal(p_message_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.agent_messages%rowtype;
begin
  if private.principal_type() is distinct from 'human' then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into m from public.agent_messages where id=p_message_id and user_id=auth.uid()
    and direction='out' and outcome->>'kind'='agent_proposed' for update;
  if not found then raise exception using errcode='PT409',message='already_settled'; end if;
  update public.agent_messages set outcome=outcome||jsonb_build_object('kind',case when p_accept then 'agent_accepted' else 'agent_declined' end) where id=m.id;
  return jsonb_build_object('name',m.outcome->>'name','harness',m.outcome->>'harness','role',m.outcome->>'role');
end $$;
revoke all on function public.settle_agent_proposal(uuid,boolean) from public,anon;
grant execute on function public.settle_agent_proposal(uuid,boolean) to authenticated;

-- Auth only reads pending authorizations. Resume an already approved result without re-approving it.
create or replace function public.connect_authorization_result(p_authorization_id text,p_auth_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object('client_id',a.client_id,'client_name',c.client_name,'redirect_uri',a.redirect_uri,
    'authorization_code',a.authorization_code,'state',a.state) into result
    from auth.oauth_authorizations a join auth.oauth_clients c on c.id=a.client_id
    join public.agents agent on agent.auth_user_id=a.user_id
    where a.authorization_id=p_authorization_id and a.user_id=p_auth_user_id and a.status='approved'
      and a.expires_at>now() and a.authorization_code is not null and c.deleted_at is null
      and agent.status='enabled' and agent.revoked_at is null and not agent.is_platform;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  return result;
end $$;
revoke all on function public.connect_authorization_result(text,uuid) from public,anon,authenticated;
grant execute on function public.connect_authorization_result(text,uuid) to service_role;
