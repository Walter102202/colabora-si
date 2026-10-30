-- 0029 · OAuth chats use the selected Auth principal, never a substituted human session.
-- Agent authorizations are read/decided by agent-admin after direct-person and membership checks.
-- Auth sees the agent itself. The hook and RLS validate a live explicit link across Data API,
-- Storage and Realtime; only the hook adds the server-owned via_user attribution.
-- As-you mode remains a full human session, restricted in consent to trusted HTTPS hosts.

-- PostgREST calls the hook as the request's role, and without usage on this schema every service-role call fails.
grant usage on schema private to service_role;

-- A rotation ticket is private, one-use and bound to the server's exact next password.
-- Encrypt it at rest; a bare time window would let a chat race Rotate login with its own password.
insert into private.app_secrets (name, value)
values ('agent_login_rotation_key', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (name) do nothing;
create table private.agent_login_rotation (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  expected_password bytea not null,
  expires_at timestamptz not null
);
alter table private.agent_login_rotation enable row level security;
revoke all on private.agent_login_rotation from public, anon, authenticated, service_role;

create or replace function public.prepare_agent_login_rotation(p_auth_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if not exists (select 1 from public.agents where auth_user_id = p_auth_user_id) then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  if p_password is null or p_password !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  select value into strict v_key from private.app_secrets where name = 'agent_login_rotation_key';
  insert into private.agent_login_rotation (auth_user_id, expected_password, expires_at)
  values (p_auth_user_id, extensions.pgp_sym_encrypt(p_password, v_key, 'cipher-algo=aes256'), clock_timestamp() + interval '30 seconds')
  on conflict (auth_user_id) do update set expected_password = excluded.expected_password, expires_at = excluded.expires_at;
end $$;
revoke all on function public.prepare_agent_login_rotation(uuid, text) from public, anon, authenticated;
grant execute on function public.prepare_agent_login_rotation(uuid, text) to service_role;

-- An agent token must never become credentials for an independent direct session.
create or replace function private.freeze_agent_credentials()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ticket private.agent_login_rotation%rowtype; v_key text;
begin
  if exists (select 1 from public.agents a where a.auth_user_id = old.id) then
    select * into v_ticket from private.agent_login_rotation where auth_user_id = old.id for update;
    if not found or v_ticket.expires_at <= clock_timestamp() or new.encrypted_password is null
       or old.email is distinct from new.email or old.email_change is distinct from new.email_change
       or old.phone is distinct from new.phone or old.phone_change is distinct from new.phone_change then
      raise exception 'agent_credentials_frozen';
    end if;
    select value into strict v_key from private.app_secrets where name = 'agent_login_rotation_key';
    if extensions.crypt(extensions.pgp_sym_decrypt(v_ticket.expected_password, v_key), new.encrypted_password)
       is distinct from new.encrypted_password then
      raise exception 'agent_credentials_frozen';
    end if;
    delete from private.agent_login_rotation where auth_user_id = old.id;
  end if;
  return new;
end $$;
revoke all on function private.freeze_agent_credentials() from public, anon, authenticated;
create trigger agents_freeze_credentials before update on auth.users for each row
  when (old.encrypted_password is distinct from new.encrypted_password
     or old.email is distinct from new.email or old.email_change is distinct from new.email_change
     or old.phone is distinct from new.phone or old.phone_change is distinct from new.phone_change)
  execute function private.freeze_agent_credentials();

-- No agent login flow enrolls factors, passkeys or additional provider identities.
create or replace function private.freeze_agent_credential_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.agents a where a.auth_user_id = new.user_id) then
    raise exception 'agent_credentials_frozen';
  end if;
  return new;
end $$;
revoke all on function private.freeze_agent_credential_insert() from public, anon, authenticated;
create trigger agents_freeze_new_credentials before insert on auth.mfa_factors
  for each row execute function private.freeze_agent_credential_insert();
create trigger agents_freeze_new_credentials before insert on auth.webauthn_credentials
  for each row execute function private.freeze_agent_credential_insert();
create trigger agents_freeze_new_credentials before insert on auth.identities
  for each row execute function private.freeze_agent_credential_insert();

-- Auth can omit client_id after MFA; OAuth AMR must never become a direct session.
create or replace function private.jwt_client_id()
returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(auth.jwt() ->> 'client_id', ''),
    case when auth.jwt() -> 'amr' @> '[{"method":"oauth_provider/authorization_code"}]'::jsonb
      then 'oauth-session-without-client' end);
$$;

-- Deletion preserves a tombstone. A missing association must never become human access.
alter table public.agent_oauth_links
  add column if not exists as_human boolean not null default false,
  add column if not exists client_name text,
  add column if not exists redirect_uri text,
  alter column workspace_id drop not null,
  alter column agent_id drop not null,
  alter column user_id drop not null,
  drop constraint agent_oauth_links_workspace_id_fkey,
  drop constraint agent_oauth_links_agent_id_fkey,
  drop constraint agent_oauth_links_user_id_fkey,
  add constraint agent_oauth_links_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete set null,
  add constraint agent_oauth_links_agent_id_fkey foreign key (agent_id) references public.agents(id) on delete set null,
  add constraint agent_oauth_links_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;

create unique index if not exists agent_oauth_links_agent_client_idx on public.agent_oauth_links (agent_id, client_id)
  where agent_id is not null and user_id is not null and revoked_at is null;

-- Explicit user form also works after a request has an agent principal.
create or replace function private.is_workspace_member_user(p_ws uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_user)
      or exists (select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id = p_user);
$$;
revoke all on function private.is_workspace_member_user(uuid, uuid) from public, anon, authenticated;

-- Validate the token's existing identity; never exchange a person's subject for an agent's.
create or replace function private.oauth_session_link()
returns public.agent_oauth_links language plpgsql stable security definer set search_path = '' as $$
declare v_l public.agent_oauth_links%rowtype; v_uid uuid := (select auth.uid()); v_client text := private.jwt_client_id();
begin
  select l.* into v_l from public.agent_oauth_links l
   where v_client <> 'oauth-session-without-client' and l.client_id = v_client and l.user_id is not null and (
     (l.as_human and private.principal_type() = 'human' and l.user_id = v_uid)
     or (not l.as_human and private.principal_type() = 'agent'
         and l.agent_id::text = auth.jwt()->'app_metadata'->>'agent_id'
         and exists (select 1 from public.agents a where a.id = l.agent_id and a.auth_user_id = v_uid)));
  if not found or v_l.revoked_at is not null or (not v_l.as_human and (
      v_l.agent_id is null or v_l.workspace_id is null
      or not private.is_workspace_member_user(v_l.workspace_id, v_l.user_id)
      or not exists (select 1 from public.agents a where a.id = v_l.agent_id
                      and (a.sponsor_user_id = v_l.user_id or private.is_owner_user(a.workspace_id, v_l.user_id))))) then
    raise sqlstate 'PGRST' using
      message = json_build_object('code', 'link_revoked', 'message', 'link_revoked', 'details', null, 'hint', null)::text,
      detail = json_build_object('status', 401, 'headers', json_build_object())::text;
  end if;
  return v_l;
end $$;
revoke all on function private.oauth_session_link() from public, anon, authenticated;

-- Storage and Realtime evaluate RLS without PostgREST's pre-request hook.
create or replace function private.oauth_session_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.oauth_session_link();
  return true;
exception when others then
  return false;
end $$;
revoke all on function private.oauth_session_ok() from public, anon, authenticated;

-- Full latest definition from 0002. Direct agent tokens never evaluate the OAuth lookup.
create or replace function private.current_agent_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.agents a
  where a.auth_user_id = (select auth.uid())
    and a.id = nullif(auth.jwt() -> 'app_metadata' ->> 'agent_id', '')::uuid
    and a.status = 'enabled' and a.revoked_at is null
    and coalesce((select (value)::boolean from private.app_flags where name = 'agents_enabled'), true)
    and case when private.jwt_client_id() is null then true else private.oauth_session_ok() end;
$$;

create or replace function private.apply_session_link()
returns void language plpgsql security definer set search_path = '' as $$
declare v_l public.agent_oauth_links%rowtype; v_claims jsonb;
begin
  if private.jwt_client_id() is null then return; end if;
  v_l := private.oauth_session_link();
  v_claims := auth.jwt() - 'via_user';
  if not v_l.as_human then v_claims := v_claims || jsonb_build_object('via_user', v_l.user_id); end if;
  perform set_config('request.jwt.claims', v_claims::text, true);
end $$;
revoke execute on function private.apply_session_link() from public;
grant execute on function private.apply_session_link() to anon, authenticated, service_role;

create or replace function public.session_identity()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_l public.agent_oauth_links%rowtype;
begin
  if private.jwt_client_id() is not null then
    v_l := private.oauth_session_link();
    if not v_l.as_human and auth.jwt()->>'via_user' is distinct from v_l.user_id::text then
      raise exception using errcode = 'PT500', message = 'session_link_not_applied';
    end if;
  end if;
  return jsonb_build_object('principal_type', private.principal_type(), 'user_id', (select auth.uid()),
    'agent_id', auth.jwt()->'app_metadata'->>'agent_id', 'workspace_id', auth.jwt()->'app_metadata'->>'workspace_id',
    'via_user', auth.jwt()->>'via_user');
end $$;
revoke all on function public.session_identity() from public, anon;
grant execute on function public.session_identity() to authenticated;

-- Agents the caller may connect a chat as. Taking on an agent's grants is a decision of its sponsor or the owner.
create or replace function public.linkable_agents()
returns table (id uuid, name text, workspace_id uuid, role text) language sql stable security definer set search_path = '' as $$
  select a.id, a.name, a.workspace_id, a.role from public.agents a
   where private.principal_type() = 'human' and private.jwt_client_id() is null
     and a.status = 'enabled' and a.revoked_at is null and not a.is_platform
     and private.is_workspace_member(a.workspace_id)
     and (a.sponsor_user_id = (select auth.uid()) or private.is_workspace_owner(a.workspace_id))
   order by a.name;
$$;
revoke all on function public.linkable_agents() from public, anon;
grant execute on function public.linkable_agents() to authenticated;

-- A null agent explicitly authorizes human identity; it never means an absent link.
create or replace function public.set_oauth_link(p_client_id text, p_agent_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_a public.agents%rowtype; v_old public.agent_oauth_links%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if coalesce(btrim(p_client_id), '') = '' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if p_agent_id is null then
    select * into v_old from public.agent_oauth_links where user_id = v_uid and client_id = p_client_id;
    insert into public.agent_oauth_links (user_id, client_id, as_human)
    values (v_uid, p_client_id, true)
    on conflict (user_id, client_id) do update set workspace_id = null, agent_id = null,
      as_human = true, created_at = now(), revoked_at = null;
    if v_old.workspace_id is not null then
      perform private.audit(v_old.workspace_id, 'oauth.unlink', jsonb_build_object('client_id', p_client_id, 'agent_id', v_old.agent_id));
    end if;
    return jsonb_build_object('linked', false);
  end if;
  select * into v_a from public.agents where id = p_agent_id;
  if not found or v_a.revoked_at is not null or v_a.status <> 'enabled' or v_a.is_platform then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  if not private.is_workspace_member(v_a.workspace_id)
     or (v_a.sponsor_user_id <> v_uid and not private.is_workspace_owner(v_a.workspace_id)) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  insert into public.agent_oauth_links (workspace_id, agent_id, user_id, client_id)
  values (v_a.workspace_id, v_a.id, v_uid, p_client_id)
  on conflict (user_id, client_id) do update
    set workspace_id = excluded.workspace_id, agent_id = excluded.agent_id, as_human = false, created_at = now(), revoked_at = null;
  perform private.audit(v_a.workspace_id, 'oauth.link', jsonb_build_object('client_id', p_client_id, 'agent_id', v_a.id));
  return jsonb_build_object('linked', true, 'agent_id', v_a.id, 'agent_name', v_a.name);
end $$;
revoke all on function public.set_oauth_link(text, uuid) from public, anon;
grant execute on function public.set_oauth_link(text, uuid) to authenticated;

-- Disconnects a linked chat now: the hook and RLS refuse its tokens until the person connects it again.
create or replace function public.revoke_oauth_link(p_client_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_l public.agent_oauth_links%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  update public.agent_oauth_links set revoked_at = now()
   where user_id = (select auth.uid()) and client_id = p_client_id and revoked_at is null returning * into v_l;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if v_l.workspace_id is not null then
    perform private.audit(v_l.workspace_id, 'oauth.revoke', jsonb_build_object('client_id', p_client_id, 'agent_id', v_l.agent_id));
  end if;
  return jsonb_build_object('revoked', true);
end $$;
revoke all on function public.revoke_oauth_link(text) from public, anon;
grant execute on function public.revoke_oauth_link(text) to authenticated;

-- Server login authorization. Disabled agents may only be used to disconnect an existing link.
create or replace function public.oauth_agent_context(p_agent_id uuid, p_client_id text default null, p_require_enabled boolean default true)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_l public.agent_oauth_links%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_a from public.agents where id = p_agent_id and not is_platform;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_member(v_a.workspace_id)
     or not (v_a.sponsor_user_id = (select auth.uid()) or private.is_workspace_owner(v_a.workspace_id)) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  if p_require_enabled and (v_a.status <> 'enabled' or v_a.revoked_at is not null) then
    raise exception using errcode = 'PT403', message = 'agent_disabled';
  end if;
  if p_client_id is not null then
    select * into v_l from public.agent_oauth_links where user_id = (select auth.uid())
      and client_id = p_client_id and agent_id = v_a.id and not as_human;
    if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  elsif not p_require_enabled then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id,
    'login_nonce', v_a.connection->>'login_nonce', 'link_revoked', v_l.revoked_at is not null);
end $$;
revoke all on function public.oauth_agent_context(uuid, text, boolean) from public, anon;
grant execute on function public.oauth_agent_context(uuid, text, boolean) to authenticated;

-- Read only the metadata needed before GoTrue binds/consumes an authorization. No code or secret is returned.
-- The server uses this before getAuthorizationDetails, whose remembered-consent response contains only a redirect.
create or replace function public.oauth_authorization_context(p_authorization_id text, p_auth_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  select jsonb_build_object('client_id', a.client_id, 'client_name', c.client_name,
                           'redirect_uri', a.redirect_uri, 'user_id', a.user_id) into v_result
    from auth.oauth_authorizations a join auth.oauth_clients c on c.id = a.client_id
   where a.authorization_id = p_authorization_id and a.expires_at > now() and a.status = 'pending'
     and c.deleted_at is null and (a.user_id is null or a.user_id = p_auth_user_id);
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  return v_result;
end $$;
revoke all on function public.oauth_authorization_context(text, uuid) from public, anon, authenticated;
grant execute on function public.oauth_authorization_context(text, uuid) to service_role;

-- For the explicitly chosen human flow only. Metadata reads do not bind the authorization in GoTrue.
create or replace function public.oauth_human_context(p_authorization_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  return public.oauth_authorization_context(p_authorization_id, (select auth.uid()));
end $$;
revoke all on function public.oauth_human_context(text) from public, anon;
grant execute on function public.oauth_human_context(text) to authenticated;

create or replace function public.set_oauth_app(p_client_id text, p_agent_id uuid, p_client_name text, p_redirect_uri text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  v_result := public.set_oauth_link(p_client_id, p_agent_id);
  update public.agent_oauth_links set client_name = p_client_name, redirect_uri = p_redirect_uri
   where user_id = (select auth.uid()) and client_id = p_client_id;
  return v_result;
end $$;
revoke all on function public.set_oauth_app(text, uuid, text, text) from public, anon;
grant execute on function public.set_oauth_app(text, uuid, text, text) to authenticated;

-- The stamp on a block says the agent wrote it and who connected the chat (via).
create or replace function private.apply_page_ops_core(p_page_id text, p_ops jsonb, p_client text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.pages%rowtype;
  v_data jsonb;
  v_before jsonb;
  v_op jsonb;
  v_actor jsonb;
  v_item jsonb;
  v_patch jsonb;
  v_array jsonb;
  v_path text[];
  v_list_path text[];
  v_predecessors jsonb := '{}';
  v_id text;
  v_after text;
  v_old_after text;
  v_index integer;
  v_rev bigint;
  v_i integer := 0;
  v_walk integer;
  v_result jsonb;
  v_results jsonb := '[]';
  v_inverse jsonb := '[]';
  v_undo jsonb;
  v_revision bigint;
  rec record;
begin
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) > 200 then
    raise exception using errcode = 'PT400', message = 'invalid_operations';
  end if;
  select * into v_row from public.pages where id = p_page_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  v_data := v_row.data;
  v_actor := jsonb_strip_nulls(jsonb_build_object('by', private.principal_type(), 'id', auth.uid(), 'via', auth.jwt() ->> 'via_user', 'runId', private.current_run_id(), 'at', floor(extract(epoch from clock_timestamp()) * 1000)::bigint));
  for rec in select * from private.block_paths(v_data) loop
    v_index := rec.path[array_length(rec.path, 1)]::integer;
    v_list_path := rec.path[1:array_length(rec.path, 1)-1];
    v_predecessors := v_predecessors || jsonb_build_object(rec.block->>'id', case when v_index > 0 then v_data #>> (v_list_path || array[(v_index - 1)::text, 'id']) else null end);
  end loop;
  for v_op in select value from jsonb_array_elements(p_ops) loop
    if jsonb_typeof(v_op) <> 'object' or not (v_op ? 'op') then raise exception using errcode = 'PT400', message = 'invalid_operation'; end if;
    if v_data is null and v_op->>'op' <> 'replace_page' then raise exception using errcode = 'PT404', message = 'page_deleted'; end if;
    v_before := v_data;
    v_result := jsonb_build_object('i', v_i, 'ok', true);
    v_undo := null;
    v_item := null;
    v_path := null;
    v_id := coalesce(v_op->>'id', v_op->>'rowId');
    if v_op->>'op' in ('update_block', 'delete_block', 'move_block') then
      v_path := private.block_path(v_data, v_id);
      if v_path is not null then v_item := v_data #> v_path; end if;
    elsif v_op->>'op' in ('db_cell_set', 'db_row_delete', 'db_row_move') then
      v_index := private.array_id_index(v_data->'database'->'rows', v_id);
      if v_index is not null then v_path := array['database','rows',v_index::text]; v_item := v_data #> v_path; end if;
    end if;
    if v_item is not null and v_op->>'op' in ('update_block','delete_block','db_cell_set','db_row_delete')
       and v_op ? 'rev' and (v_op->>'rev')::bigint < coalesce((v_item->>'rev')::bigint, 0) then
      if private.is_agent() then
        raise exception using errcode = 'PT409', message = 'block_conflict', detail = jsonb_build_object('page_id', p_page_id, 'block_id', v_id, 'rev', v_item->'rev', 'text', left(coalesce(v_item->>'html', v_item::text), 2000))::text;
      end if;
      v_result := v_result || jsonb_build_object('conflict', jsonb_strip_nulls(jsonb_build_object('id', v_id, 'theirs', case when v_op->>'op' = 'db_cell_set' then coalesce(v_item->'cells'->(v_op->>'propertyId'), 'null') else v_item end, 'by', v_item->'attr')));
    end if;
    case v_op->>'op'
      when 'insert_block' then
        v_item := v_op->'block';
        if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'id','') = '' or private.block_path(v_data, v_item->>'id') is not null then raise exception using errcode = 'PT400', message = 'invalid_block'; end if;
        v_after := v_op->>'after'; v_walk := 0;
        while v_after is not null and private.block_path(v_data, v_after) is null loop
          v_after := v_predecessors->>v_after; v_walk := v_walk + 1;
          if v_walk > 10000 then v_after := null; end if;
        end loop;
        v_path := private.block_path(v_data, v_after);
        v_list_path := case when v_path is null then array['blocks'] else v_path[1:array_length(v_path,1)-1] end;
        v_rev := coalesce((v_item->>'rev')::bigint, 0) + 1;
        v_item := v_item || jsonb_build_object('rev', v_rev, 'attr', v_actor);
        v_data := jsonb_set(v_data, v_list_path, private.array_insert_after(v_data #> v_list_path, v_item, v_after), true);
        v_predecessors := v_predecessors || jsonb_build_object(v_item->>'id', v_after);
        v_result := v_result || jsonb_build_object('rev', v_rev);
        v_undo := jsonb_build_object('op','delete_block','id',v_item->>'id');
      when 'update_block' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_patch := coalesce(v_op->'patch','{}') - 'id' - 'rev' - 'attr';
          if jsonb_typeof(v_patch) <> 'object' then raise exception using errcode = 'PT400', message = 'invalid_block_patch'; end if;
          select coalesce(jsonb_object_agg(key, v_item->key), '{}') into v_array from jsonb_object_keys(v_patch) key;
          v_undo := jsonb_build_object('op','update_block','id',v_id,'patch',v_array);
          v_rev := coalesce((v_item->>'rev')::bigint, 0) + 1;
          v_data := jsonb_set(v_data, v_path, v_item || v_patch || jsonb_build_object('rev',v_rev,'attr',v_actor));
          v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'delete_block' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[array_length(v_path,1)]::integer;
          v_list_path := v_path[1:array_length(v_path,1)-1];
          v_old_after := case when v_index > 0 then v_data #>> (v_list_path || array[(v_index-1)::text,'id']) else null end;
          v_undo := jsonb_build_object('op','insert_block','after',v_old_after,'block',v_item);
          v_data := v_data #- v_path;
          v_result := v_result || jsonb_build_object('rev',coalesce((v_item->>'rev')::bigint,0)+1);
        end if;
      when 'move_block' then
        if v_item is null or v_op->>'after' = v_id then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[array_length(v_path,1)]::integer;
          v_list_path := v_path[1:array_length(v_path,1)-1];
          v_old_after := case when v_index > 0 then v_data #>> (v_list_path || array[(v_index-1)::text,'id']) else null end;
          v_undo := jsonb_build_object('op','move_block','id',v_id,'after',v_old_after);
          v_data := v_data #- v_path;
          v_after := v_op->>'after'; v_walk := 0;
          while v_after is not null and private.block_path(v_data,v_after) is null loop
            v_after := v_predecessors->>v_after; v_walk := v_walk + 1; if v_walk > 10000 then v_after := null; end if;
          end loop;
          v_path := private.block_path(v_data,v_after);
          v_list_path := case when v_path is null then array['blocks'] else v_path[1:array_length(v_path,1)-1] end;
          v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
          v_data := jsonb_set(v_data,v_list_path,private.array_insert_after(v_data #> v_list_path,v_item || jsonb_build_object('rev',v_rev,'attr',v_actor),v_after));
          v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'set_page' then
        select coalesce(jsonb_object_agg(key,value),'{}') into v_patch from jsonb_each(coalesce(v_op->'patch','{}'))
        where key = any(array['title','icon','cover','coverPosition','fullWidth','smallText','locked','font','isFavorite']);
        select coalesce(jsonb_object_agg(key,v_data->key),'{}') into v_array from jsonb_object_keys(v_patch) key;
        v_undo := jsonb_build_object('op','set_page','patch',v_array);
        v_data := v_data || v_patch;
      when 'db_row_add' then
        if v_data->'database' is null then raise exception using errcode = 'PT400', message = 'not_a_database'; end if;
        v_item := v_op->'row';
        if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'id','') = '' then raise exception using errcode = 'PT400', message = 'invalid_row'; end if;
        v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
        v_item := v_item || jsonb_build_object('rev',v_rev,'createdBy',coalesce(v_item->>'createdBy',auth.uid()::text),'lastEditedBy',auth.uid());
        v_data := jsonb_set(v_data,'{database,rows}',private.array_insert_after(v_data->'database'->'rows',v_item,v_op->>'after'));
        v_result := v_result || jsonb_build_object('rev',v_rev);
        v_undo := jsonb_build_object('op','db_row_delete','rowId',v_item->>'id');
      when 'db_cell_set' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_undo := jsonb_build_object('op','db_cell_set','rowId',v_id,'propertyId',v_op->>'propertyId','value',coalesce(v_item->'cells'->(v_op->>'propertyId'),'null'));
          v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
          v_item := v_item || jsonb_build_object('cells',coalesce(v_item->'cells','{}') || jsonb_build_object(v_op->>'propertyId',coalesce(v_op->'value','null')),'rev',v_rev,'lastEditedBy',auth.uid());
          v_data := jsonb_set(v_data,v_path,v_item); v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'db_row_delete' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[3]::integer;
          v_undo := jsonb_build_object('op','db_row_add','row',v_item,'after',case when v_index > 0 then v_data #>> array['database','rows',(v_index-1)::text,'id'] else null end);
          select coalesce(jsonb_agg(case when value->>'parentRowId' = v_id then value - 'parentRowId' else value end order by ordinality),'[]') into v_array
          from jsonb_array_elements(v_data->'database'->'rows') with ordinality where value->>'id' <> v_id;
          v_data := jsonb_set(v_data,'{database,rows}',v_array); v_result := v_result || jsonb_build_object('rev',coalesce((v_item->>'rev')::bigint,0)+1);
        end if;
      when 'db_row_move' then
        if v_item is null then v_result := v_result || '{"ok":false}';
        else
          v_index := v_path[3]::integer;
          v_undo := jsonb_build_object('op','db_row_move','rowId',v_id,'after',case when v_index > 0 then v_data #>> array['database','rows',(v_index-1)::text,'id'] else null end,'parentRowId',v_item->'parentRowId');
          v_rev := coalesce((v_item->>'rev')::bigint,0)+1;
          v_item := v_item || jsonb_build_object('rev',v_rev,'lastEditedBy',auth.uid());
          if v_op ? 'parentRowId' then v_item := v_item || jsonb_build_object('parentRowId',v_op->'parentRowId'); end if;
          v_data := jsonb_set(v_data,'{database,rows}',private.array_insert_after(v_data->'database'->'rows',v_item,v_op->>'after'));
          v_result := v_result || jsonb_build_object('rev',v_rev);
        end if;
      when 'db_prop_set' then
        v_item := v_op->'property'; v_index := private.array_id_index(v_data->'database'->'properties',v_item->>'id');
        if v_index is null then v_undo := jsonb_build_object('op','db_prop_delete','propertyId',v_item->>'id');
        else v_undo := jsonb_build_object('op','db_prop_set','property',v_data->'database'->'properties'->v_index,'after',case when v_index > 0 then v_data #>> array['database','properties',(v_index-1)::text,'id'] else null end); end if;
        if v_op ? 'after' or v_index is null then
          v_after := case when v_op ? 'after' then v_op->>'after' else v_data->'database'->'properties'->-1->>'id' end;
          v_data := jsonb_set(v_data,'{database,properties}',private.array_insert_after(v_data->'database'->'properties',v_item,v_after));
        else v_data := jsonb_set(v_data,array['database','properties',v_index::text],v_item); end if;
      when 'db_prop_delete' then
        v_id := v_op->>'propertyId'; v_index := private.array_id_index(v_data->'database'->'properties',v_id);
        if v_index is not null then
          v_undo := jsonb_build_object('op','replace_page','page',v_before,'revision',v_row.revision);
          v_data := v_data #- array['database','properties',v_index::text];
          select coalesce(jsonb_agg(jsonb_set(value,'{cells}',coalesce(value->'cells','{}') - v_id) order by ordinality),'[]') into v_array from jsonb_array_elements(v_data->'database'->'rows') with ordinality;
          v_data := jsonb_set(v_data,'{database,rows}',v_array);
        end if;
      when 'db_view_set' then
        v_item := v_op->'view'; v_index := private.array_id_index(v_data->'database'->'views',v_item->>'id');
        if v_index is null then v_data := jsonb_set(v_data,'{database,views}',coalesce(v_data->'database'->'views','[]') || jsonb_build_array(v_item)); v_undo := jsonb_build_object('op','db_view_delete','viewId',v_item->>'id');
        else v_undo := jsonb_build_object('op','db_view_set','view',v_data #> array['database','views',v_index::text]); v_data := jsonb_set(v_data,array['database','views',v_index::text],v_item); end if;
      when 'db_view_delete' then
        v_index := private.array_id_index(v_data->'database'->'views',v_op->>'viewId');
        if v_index is not null then v_undo := jsonb_build_object('op','db_view_set','view',v_data #> array['database','views',v_index::text]); v_data := v_data #- array['database','views',v_index::text]; end if;
      when 'comment_add' then
        v_item := v_op->'comment';
        if coalesce(btrim(v_item->>'body'),'') = '' then raise exception using errcode = 'PT400', message = 'empty_comment'; end if;
        v_item := v_item || jsonb_build_object('authorId',auth.uid(),'authorType',private.principal_type());
        select coalesce(jsonb_agg(value order by ordinality),'[]') into v_array from jsonb_array_elements(coalesce(v_data->'comments','[]')) with ordinality where value->>'id' <> v_item->>'id';
        v_data := jsonb_set(v_data,'{comments}',v_array || jsonb_build_array(v_item),true);
        v_index := private.array_id_index(v_before->'comments',v_item->>'id');
        if v_index is null then
          v_undo := jsonb_build_object('op','comment_delete','id',v_item->>'id');
          perform private.notify_comment(p_page_id,v_row.workspace_id,v_before,v_item);
        else v_undo := jsonb_build_object('op','comment_add','comment',v_before->'comments'->v_index); end if;
      when 'comment_set' then
        v_index := private.array_id_index(v_data->'comments',v_id);
        if v_index is not null then
          v_item := v_data->'comments'->v_index;
          if (v_op->'patch') ? 'body' and v_item->>'authorId' is distinct from auth.uid()::text then raise exception using errcode = 'PT403', message = 'comment_author_only'; end if;
          v_patch := coalesce(v_op->'patch','{}') - 'id' - 'authorId' - 'authorType' - 'runId';
          v_data := jsonb_set(v_data,array['comments',v_index::text],v_item || v_patch);
        end if;
      when 'comment_delete' then
        v_index := private.array_id_index(v_data->'comments',v_id);
        if v_index is not null then
          v_item := v_data->'comments'->v_index;
          if private.is_agent() and v_item->>'authorId' is distinct from auth.uid()::text then raise exception using errcode = 'PT403', message = 'comment_author_only'; end if;
          v_undo := jsonb_build_object('op','comment_add','comment',v_item);
          v_data := v_data #- array['comments',v_index::text];
        end if;
      when 'version_delete' then
        if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
        v_index := private.array_id_index(v_data->'versions',v_id);
        if v_index is not null then
          v_undo := jsonb_build_object('op','version_add','version',v_data->'versions'->v_index);
          v_data := v_data #- array['versions',v_index::text];
        end if;
      when 'version_add' then
        select coalesce(jsonb_agg(value order by ordinality),'[]') into v_array from (
          select value, ordinality from jsonb_array_elements(coalesce(v_data->'versions','[]')) with ordinality where value->>'id' <> v_op->'version'->>'id' order by ordinality limit 9
        ) versions;
        v_data := jsonb_set(v_data,'{versions}',jsonb_build_array(v_op->'version') || v_array,true);
      when 'replace_page' then
        if private.is_agent() then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
        if jsonb_typeof(v_op->'page') is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_page'; end if;
        if coalesce(v_op->>'revision','') !~ '^[0-9]+$' then raise exception using errcode = 'PT400', message = 'invalid_revision'; end if;
        if v_row.data is not null and (v_op->>'revision')::bigint <> v_row.revision then
          raise exception using errcode = 'PT409', message = 'page_conflict', detail = jsonb_build_object('page_id', p_page_id, 'revision', v_row.revision)::text;
        end if;
        v_data := (v_op->'page') || jsonb_build_object('id',p_page_id);
      else raise exception using errcode = 'PT400', message = 'unknown_operation';
    end case;
    if v_data is distinct from v_before then
      if v_undo is null then v_undo := jsonb_build_object('op','replace_page','page',v_before,'revision',v_row.revision); end if;
      v_inverse := jsonb_build_array(v_undo) || v_inverse;
    end if;
    v_results := v_results || jsonb_build_array(v_result); v_i := v_i + 1;
  end loop;
  perform set_config('app.ops_write','1',true);
  update public.pages set data = v_data || jsonb_build_object('_client',p_client),
    deleted_at = case when coalesce((v_data->>'isDeleted')::boolean,false) then coalesce(deleted_at,now()) else null end,
    parent_id = case when v_data ? 'parentId' then v_data->>'parentId' else parent_id end
    where id = p_page_id returning revision into v_revision;
  perform set_config('app.ops_write','',true);
  return jsonb_build_object('revision',v_revision,'results',v_results,'inverse',v_inverse);
end;
$$;
revoke all on function private.apply_page_ops_core(text,jsonb,text) from public, anon, authenticated;


-- Last, once the function exists: registered earlier, every Data API request would fail in between.
alter role authenticator set pgrst.db_pre_request = 'private.apply_session_link';
notify pgrst, 'reload config';

-- Replaces 0002: only a direct human session may issue a persistent agent credential.
create or replace function public.issue_agent_token(p_agent_id uuid, p_name text default 'default', p_scopes text[] default array['mcp']::text[], p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_token text; v_id uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_a from public.agents where id = p_agent_id and revoked_at is null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_member(v_a.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if not (v_a.sponsor_user_id = (select auth.uid()) or exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid()))) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  v_token := 'agt_' || private.random_base62(40);
  insert into public.agent_tokens (workspace_id, agent_id, name, token_hash, token_prefix, scopes, expires_at, created_by)
  values (v_a.workspace_id, p_agent_id, coalesce(p_name, 'default'), private.hash_agent_token(v_token), left(v_token, 8), coalesce(p_scopes, array['mcp']::text[]), p_expires_at, (select auth.uid()))
  returning id into v_id;
  perform private.audit(v_a.workspace_id, 'token.issue', jsonb_build_object('token_id', v_id, 'agent_id', p_agent_id));
  return jsonb_build_object('token_id', v_id, 'token', v_token, 'token_prefix', left(v_token, 8));
end $$;
revoke all on function public.issue_agent_token(uuid, text, text[], timestamptz) from public, anon;
grant execute on function public.issue_agent_token(uuid, text, text[], timestamptz) to authenticated;

-- Replaces 0002: former membership cannot authorize an agent operation.
create or replace function public.update_agent(p_agent_id uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_bad text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_member(v_a.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if not (v_a.sponsor_user_id = (select auth.uid()) or exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid()))) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  select key into v_bad from jsonb_each(p_patch)
   where key not in ('name','capabilities','connection','monthly_budget_usd','rate_limit_per_min','status') limit 1;
  if v_bad is not null then raise exception using errcode = 'PT422', message = 'field_not_allowed', detail = v_bad; end if;
  if p_patch ? 'status' and (p_patch->>'status') not in ('enabled','paused') then
    raise exception using errcode = 'PT422', message = 'invalid_state';
  end if;
  update public.agents set
    name = coalesce(p_patch->>'name', name),
    capabilities = coalesce(p_patch->'capabilities', capabilities),
    connection = coalesce(p_patch->'connection', connection),
    monthly_budget_usd = case when p_patch ? 'monthly_budget_usd' then (p_patch->>'monthly_budget_usd')::numeric else monthly_budget_usd end,
    rate_limit_per_min = coalesce((p_patch->>'rate_limit_per_min')::int, rate_limit_per_min),
    status = case when p_patch ? 'status' and status <> 'disabled' then p_patch->>'status' else status end,
    updated_at = now()
  where id = p_agent_id;
  perform private.audit(v_a.workspace_id, 'agent.update', jsonb_build_object('agent_id', p_agent_id, 'patch', p_patch));
end $$;

-- Replaces 0002: former membership cannot authorize an agent operation.
create or replace function public.revoke_agent_token(p_token_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tokens%rowtype; v_a public.agents%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_t from public.agent_tokens where id = p_token_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select * into v_a from public.agents where id = v_t.agent_id;
  if not private.is_workspace_member(v_a.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if not (v_a.sponsor_user_id = (select auth.uid()) or exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid()))) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  update public.agent_tokens set revoked_at = now() where id = p_token_id;
  perform private.audit(v_t.workspace_id, 'token.revoke', jsonb_build_object('token_id', p_token_id));
end $$;

-- Replaces 0002: former membership cannot authorize an agent operation.
create or replace function public.lookup_agent_token(p_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tokens%rowtype; v_a public.agents%rowtype;
begin
  select * into v_t from public.agent_tokens where token_hash = p_hash and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then return null; end if;
  select * into v_a from public.agents where id = v_t.agent_id and revoked_at is null;
  if not found then return null; end if;
  if v_a.status <> 'enabled' or not coalesce((select (value)::boolean from private.app_flags where name = 'agents_enabled'), true) then
    raise exception using errcode = 'PT403', message = 'agent_disabled';
  end if;
  if not private.is_workspace_member_user(v_t.workspace_id, v_t.created_by) then return null; end if;
  update public.agent_tokens set last_used_at = now() where id = v_t.id;
  return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id, 'workspace_id', v_a.workspace_id, 'scopes', to_jsonb(v_t.scopes), 'token_id', v_t.id);
end $$;
