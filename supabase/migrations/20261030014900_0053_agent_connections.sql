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
