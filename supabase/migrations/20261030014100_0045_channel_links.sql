-- Verified person/channel links and a persistent inbox. Decision RPCs are added in 0046.
create table public.agent_channel_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check(channel in ('telegram','whatsapp')),
  chat_id text not null, from_id text not null,
  created_at timestamptz not null default now(), revoked_at timestamptz
);
create unique index channel_person_active on public.agent_channel_links(workspace_id,user_id,channel) where revoked_at is null;
create unique index channel_chat_active on public.agent_channel_links(channel,chat_id) where revoked_at is null;
alter table public.agent_channel_links enable row level security;
revoke all on public.agent_channel_links from anon,authenticated;
grant select on public.agent_channel_links to authenticated;
grant all on public.agent_channel_links to service_role;
create policy "person reads own channel links" on public.agent_channel_links for select to authenticated
  using (user_id=auth.uid() and private.is_human_member(workspace_id) and private.jwt_client_id() is null);

create table private.channel_link_codes (
  code_hash text primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null, used_at timestamptz
);
revoke all on private.channel_link_codes from public,anon,authenticated;

create or replace function public.start_channel_link(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text; v_bot text;
begin
  if private.principal_type()<>'human' or private.jwt_client_id() is not null or not private.is_human_member(p_workspace_id)
    then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select value into v_bot from private.app_secrets where name='telegram_bot_username';
  if v_bot is null or v_bot !~ '^[A-Za-z0-9_]{5,32}$' then raise exception using errcode='PT503',message='channel_not_configured'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||auth.uid()::text||':channel-link',0));
  update private.channel_link_codes set used_at=now() where workspace_id=p_workspace_id and user_id=auth.uid() and used_at is null;
  v_code:=encode(extensions.gen_random_bytes(24),'hex');
  insert into private.channel_link_codes values(encode(extensions.digest(v_code,'sha256'),'hex'),p_workspace_id,auth.uid(),now()+interval '10 minutes',null);
  return jsonb_build_object('url','https://t.me/'||v_bot||'?start='||v_code,'expires_at',now()+interval '10 minutes');
end $$;
revoke all on function public.start_channel_link(uuid) from public,anon;
grant execute on function public.start_channel_link(uuid) to authenticated;

create or replace function public.disconnect_channel(p_workspace_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if private.principal_type()<>'human' or private.jwt_client_id() is not null or not private.is_human_member(p_workspace_id)
    then raise exception using errcode='PT403',message='direct_session_required'; end if;
  update public.agent_channel_links set revoked_at=now() where workspace_id=p_workspace_id and user_id=auth.uid() and revoked_at is null;
  update private.channel_link_codes set used_at=now() where workspace_id=p_workspace_id and user_id=auth.uid() and used_at is null;
end $$;
revoke all on function public.disconnect_channel(uuid) from public,anon;
grant execute on function public.disconnect_channel(uuid) to authenticated;

create or replace function public.redeem_channel_link(p_code text,p_chat_id text,p_from_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code private.channel_link_codes%rowtype; v_id uuid;
begin
  if p_chat_id is null or p_chat_id !~ '^[0-9]{1,20}$' or p_chat_id is distinct from p_from_id then raise exception using errcode='PT403',message='not_linked'; end if;
  select * into v_code from private.channel_link_codes where code_hash=encode(extensions.digest(p_code,'sha256'),'hex') for update;
  if not found or v_code.used_at is not null or v_code.expires_at<=now() or not private.is_workspace_member_user(v_code.workspace_id,v_code.user_id)
    then raise exception using errcode='PT403',message='invalid_link_code'; end if;
  perform pg_advisory_xact_lock(hashtextextended('telegram:'||p_chat_id,0));
  update private.channel_link_codes set used_at=now() where code_hash=v_code.code_hash;
  update public.agent_channel_links set revoked_at=now() where channel='telegram' and revoked_at is null
    and ((workspace_id=v_code.workspace_id and user_id=v_code.user_id) or chat_id=p_chat_id);
  insert into public.agent_channel_links(workspace_id,user_id,channel,chat_id,from_id)
    values(v_code.workspace_id,v_code.user_id,'telegram',p_chat_id,p_from_id) returning id into v_id;
  return jsonb_build_object('linked',true,'link_id',v_id);
end $$;
revoke all on function public.redeem_channel_link(text,text,text) from public,anon,authenticated;
grant execute on function public.redeem_channel_link(text,text,text) to service_role;

-- Only trusted webhook callers use this helper, never an agent-supplied identity.
create or replace function private.verified_channel_link(p_chat_id text,p_from_id text)
returns public.agent_channel_links language plpgsql stable security definer set search_path='' as $$
declare v public.agent_channel_links%rowtype;
begin
  select * into v from public.agent_channel_links where channel='telegram' and chat_id=p_chat_id and from_id=p_from_id and revoked_at is null;
  if not found or not private.is_workspace_member_user(v.workspace_id,v.user_id) then raise exception using errcode='PT403',message='not_linked'; end if;
  return v;
end $$;
revoke all on function private.verified_channel_link(text,text) from public,anon,authenticated;

create or replace function private.channel_person(p_agent public.agents,p_channel text,p_chat_id text)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_user uuid;
begin
  if p_channel<>'telegram' or p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then return null; end if;
  select user_id into v_user from public.agent_channel_links where workspace_id=p_agent.workspace_id and channel=p_channel and chat_id=p_chat_id and revoked_at is null;
  if found then
    if private.is_workspace_member_user(p_agent.workspace_id,v_user) then return v_user; end if;
    return null;
  end if;
  -- Backward compatibility for an installation that has never paired. Webhook intake never calls this fallback.
  if exists(select 1 from public.agent_channel_links where workspace_id=p_agent.workspace_id and channel=p_channel) then return null; end if;
  if private.is_workspace_member_user(p_agent.workspace_id,p_agent.sponsor_user_id) then return p_agent.sponsor_user_id; end if;
  return null;
end $$;

create table public.channel_updates (
  update_id bigint primary key,
  link_id uuid not null references public.agent_channel_links(id),
  payload jsonb not null,
  created_at timestamptz not null default now(), acknowledged_at timestamptz
);
create index channel_updates_pending on public.channel_updates(link_id,update_id) where acknowledged_at is null;
alter table public.channel_updates enable row level security;
revoke all on public.channel_updates from anon,authenticated;
grant all on public.channel_updates to service_role;

create or replace function public.enqueue_channel_update(p_update_id bigint,p_chat_id text,p_from_id text,p_message jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.agent_channel_links%rowtype;
begin
  v:=private.verified_channel_link(p_chat_id,p_from_id);
  if p_update_id is null or p_update_id<0 or p_message#>>'{chat,type}' is distinct from 'private'
    or p_message#>>'{chat,id}' is distinct from p_chat_id or p_message#>>'{from,id}' is distinct from p_from_id
    or coalesce((p_message#>>'{from,is_bot}')::boolean,false) then raise exception using errcode='PT403',message='invalid_sender'; end if;
  insert into public.channel_updates(update_id,link_id,payload) values(p_update_id,v.id,p_message) on conflict(update_id) do nothing;
  return jsonb_build_object('queued',true);
end $$;
revoke all on function public.enqueue_channel_update(bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_channel_update(bigint,text,text,jsonb) to service_role;

create or replace function public.take_channel_updates(p_ack_update_id bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_a public.agents%rowtype; v_items jsonb;
begin
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  select * into v_a from public.agents where id=private.current_agent_id() and is_platform and revoked_at is null;
  if not found then raise exception using errcode='PT403',message='platform_only'; end if;
  if p_ack_update_id is not null then
    update public.channel_updates u set acknowledged_at=now() from public.agent_channel_links l
      where u.update_id=p_ack_update_id and u.link_id=l.id and l.workspace_id=v_a.workspace_id;
    if not found then raise exception using errcode='PT404',message='not_found'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('update_id',x.update_id,'message',x.payload) order by x.update_id),'[]') into v_items from (
    select u.update_id,u.payload from public.channel_updates u join public.agent_channel_links l on l.id=u.link_id
    where l.workspace_id=v_a.workspace_id and l.revoked_at is null and private.is_workspace_member_user(l.workspace_id,l.user_id)
      and u.acknowledged_at is null order by u.update_id limit 20) x;
  return jsonb_build_object('updates',v_items);
end $$;
revoke all on function public.take_channel_updates(bigint) from public,anon;
grant execute on function public.take_channel_updates(bigint) to authenticated;
