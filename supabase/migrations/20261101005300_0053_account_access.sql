-- One lifetime invitation allowance per owner, across workspaces. Old recipients are exempt.
create table private.invite_allowance (singleton boolean primary key default true check (singleton), maximum integer not null check (maximum >= 0));
insert into private.invite_allowance values (true,1);
create table private.invite_recipients (
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  counted boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(owner_id,email)
);
insert into private.invite_recipients(owner_id,email,counted)
select w.owner_id,lower(btrim(u.email)),false from public.workspace_members m
join public.workspaces w on w.id=m.workspace_id join auth.users u on u.id=m.user_id
where m.user_id<>w.owner_id and u.email is not null
union select w.owner_id,lower(btrim(i.email)),false from public.workspace_invitations i join public.workspaces w on w.id=i.workspace_id
on conflict do nothing;
alter table private.invite_allowance enable row level security;
alter table private.invite_recipients enable row level security;
revoke all on private.invite_allowance,private.invite_recipients from public,anon,authenticated;

drop policy "owner inserts members" on public.workspace_members;
create policy "owner bootstraps own membership" on public.workspace_members for insert to authenticated with check (
  private.principal_type()='human' and user_id=(select auth.uid()) and role='owner'
  and exists(select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=(select auth.uid()))
);
drop policy "editors insert invitations" on public.workspace_invitations;
drop policy "owner updates invitations" on public.workspace_invitations;
revoke insert,update on public.workspace_invitations from authenticated;
-- Updating keys would be another way to add a new recipient. Only role changes are a browser operation.
revoke update on public.workspace_members from authenticated;
grant update(role) on public.workspace_members to authenticated;

create or replace function public.invite_member(p_workspace_id uuid,p_email text,p_role text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_token text; v_id uuid; v_url text; v_secret text; v_email text:=lower(btrim(p_email)); v_confirmed boolean;
begin
  if private.principal_type()<>'human' or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=auth.uid()) then raise exception using errcode='PT403',message='owner_required'; end if;
  if p_role is null or p_role not in ('editor','viewer') then raise exception using errcode='PT422',message='invalid_role'; end if;
  if coalesce(v_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email)>254 then raise exception using errcode='PT422',message='invalid_email'; end if;
  v_user:=private.user_id_by_email(v_email);
  if v_user=auth.uid() then raise exception using errcode='PT422',message='owner_role_fixed'; end if;
  if exists(select 1 from auth.users u where u.id=v_user and u.raw_app_meta_data->>'principal_type'='agent') or exists(select 1 from public.agents where auth_user_id=v_user) then raise exception using errcode='PT422',message='target_is_agent'; end if;
  -- Serialize different recipients for the same owner, including simultaneous requests in different workspaces.
  perform pg_advisory_xact_lock(hashtextextended('invite:'||auth.uid()::text,0));
  if not exists(select 1 from private.invite_recipients where owner_id=auth.uid() and email=v_email) then
    if (select count(*) from private.invite_recipients where owner_id=auth.uid() and counted)>=(select maximum from private.invite_allowance where singleton) then raise exception using errcode='PT403',message='invite_limit_reached'; end if;
    insert into private.invite_recipients(owner_id,email) values(auth.uid(),v_email);
  end if;
  select email_confirmed_at is not null into v_confirmed from auth.users where id=v_user;
  if v_confirmed then
    insert into public.workspace_members(workspace_id,user_id,role,invited_by) values(p_workspace_id,v_user,p_role,auth.uid()) on conflict(workspace_id,user_id) do update set role=excluded.role,invited_by=excluded.invited_by;
    insert into public.notifications(workspace_id,user_id,kind,actor_id,actor_type,payload) values(p_workspace_id,v_user,'invite',auth.uid(),'human',jsonb_build_object('role',p_role));
    return jsonb_build_object('status','joined','user_id',v_user);
  end if;
  -- Replace pending invitations so a re-invite changes the role and invalidates older workspace tokens.
  delete from public.workspace_invitations where workspace_id=p_workspace_id and lower(email)=v_email and accepted_at is null;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.workspace_invitations(workspace_id,email,role,token_hash,invited_by) values(p_workspace_id,v_email,p_role,encode(extensions.digest(v_token,'sha256'),'hex'),auth.uid()) returning id into v_id;
  select value into v_url from private.app_secrets where name='project_url';
  select value into v_secret from private.app_secrets where name='cron_secret';
  if v_url is not null and v_secret is not null then
    perform net.http_post(url:=v_url||'/functions/v1/send-email',headers:=jsonb_build_object('Content-Type','application/json','x-push-secret',v_secret),body:=jsonb_build_object('invitation_id',v_id,'token',v_token));
  end if;
  return jsonb_build_object('status','invited','invitation_id',v_id);
end $$;
revoke all on function public.invite_member(uuid,text,text) from public,anon;
grant execute on function public.invite_member(uuid,text,text) to authenticated;

-- Account inspection is exclusively for the mail functions. A supplied workspace token must still bind this email.
create function public.account_link_target(p_email text,p_invite text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user auth.users%rowtype; v_inv public.workspace_invitations%rowtype; v_workspace jsonb;
begin
  select * into v_user from auth.users where lower(email)=lower(btrim(p_email));
  if v_user.raw_app_meta_data->>'principal_type'='agent' or exists(select 1 from public.agents where auth_user_id=v_user.id) then return null; end if;
  if p_invite is not null then
    select * into v_inv from public.workspace_invitations where token_hash=encode(extensions.digest(p_invite,'sha256'),'hex')
      and lower(email)=lower(btrim(p_email)) and accepted_at is null and expires_at>now();
    if not found then return null; end if;
    select jsonb_build_object('name',left(w.name,100),'inviter',left(coalesce(nullif(u.raw_user_meta_data->>'full_name',''),u.email,'Someone'),80)) into v_workspace
      from public.workspaces w left join auth.users u on u.id=v_inv.invited_by where w.id=v_inv.workspace_id;
  end if;
  return jsonb_build_object('exists',v_user.id is not null,'confirmed',v_user.email_confirmed_at is not null,'workspace',v_workspace);
end $$;
revoke all on function public.account_link_target(text,text) from public,anon,authenticated;
grant execute on function public.account_link_target(text,text) to service_role;

create table private.account_link_attempts (
  key text not null, window_start timestamptz not null, attempts integer not null default 1, primary key(key,window_start)
);
create index account_link_attempts_window on private.account_link_attempts(window_start);
alter table private.account_link_attempts enable row level security;
revoke all on private.account_link_attempts from public,anon,authenticated;
create function public.account_link_allowed(p_ip_hash text,p_email_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_ip integer; v_email integer;
begin
  if coalesce(p_ip_hash,'')='' or coalesce(p_email_hash,'')='' then return false; end if;
  delete from private.account_link_attempts where window_start<date_trunc('hour',now());
  insert into private.account_link_attempts as a(key,window_start) values('ip:'||p_ip_hash,date_trunc('hour',now()))
    on conflict(key,window_start) do update set attempts=a.attempts+1 returning attempts into v_ip;
  insert into private.account_link_attempts as a(key,window_start) values('email:'||p_email_hash,date_trunc('hour',now()))
    on conflict(key,window_start) do update set attempts=a.attempts+1 returning attempts into v_email;
  return v_ip<=20 and v_email<=5;
end $$;
revoke all on function public.account_link_allowed(text,text) from public,anon,authenticated;
grant execute on function public.account_link_allowed(text,text) to service_role;
