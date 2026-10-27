-- 0002_agents: agent identity, page grants, personal access tokens, OAuth links.
-- Replaces the two SQL plugs declared in 0001 (private.agent_can_read / agent_can_write).
-- Depends on 0001_core (workspaces, pages, private helpers, private.app_secrets, private.app_flags).

-- ============ tables ============

create table public.agents (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  auth_user_id       uuid not null unique references auth.users(id) on delete cascade,
  name               text not null check (length(name) between 1 and 80),
  kind               text not null check (kind in ('mcp_client','webhook','a2a','managed','acp_local')),
  delivery           text not null default 'pull' check (delivery in ('pull','push')),
  role               text not null default 'worker' check (role in ('worker','lead')),
  sponsor_user_id    uuid not null references auth.users(id),
  status             text not null default 'enabled' check (status in ('enabled','paused','disabled')),
  monthly_budget_usd numeric(12,4),
  capabilities       jsonb not null default '{}'::jsonb,
  connection         jsonb not null default '{}'::jsonb,
  rate_limit_per_min int  not null default 120 check (rate_limit_per_min > 0),
  created_by         uuid not null references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  revoked_at         timestamptz
);
create index agents_workspace_idx on public.agents (workspace_id) where revoked_at is null;

create table public.agent_grants (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  page_id      text not null references public.pages(id) on delete cascade,
  scopes       text[] not null check (scopes <@ array['read','write','comment']::text[] and cardinality(scopes) > 0),
  inherit      boolean not null default true,
  granted_by   uuid not null references auth.users(id),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (agent_id, page_id)
);
create index agent_grants_lookup_idx on public.agent_grants (agent_id, page_id) where revoked_at is null;
create index agent_grants_page_idx   on public.agent_grants (page_id) where revoked_at is null;

create table public.agent_tokens (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  name         text not null default 'default',
  token_hash   text not null unique,
  token_prefix text not null,
  scopes       text[] not null default array['mcp']::text[] check (scopes <@ array['mcp','dispatch']::text[]),
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index agent_tokens_agent_idx on public.agent_tokens (agent_id) where revoked_at is null;

create table public.agent_oauth_links (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  client_id    text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (user_id, client_id)
);

create table private.agent_secrets (
  agent_id   uuid not null references public.agents(id) on delete cascade,
  name       text not null,
  value      text not null,
  created_at timestamptz not null default now(),
  primary key (agent_id, name)
);
alter table private.agent_secrets enable row level security;
revoke all on private.agent_secrets from public, anon, authenticated;

create table private.rate_counters (
  agent_id     uuid not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (agent_id, window_start)
);
revoke all on private.rate_counters from public, anon, authenticated;

-- ============ helpers that read agent tables ============

create or replace function private.current_agent_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.agents a
  where a.auth_user_id = (select auth.uid())
    and a.id = nullif(auth.jwt() -> 'app_metadata' ->> 'agent_id', '')::uuid
    and a.status = 'enabled' and a.revoked_at is null
    and coalesce((select (value)::boolean from private.app_flags where name = 'agents_enabled'), true);
$$;

create or replace function private.jwt_client_id()
returns text language sql stable set search_path = '' as $$
  select nullif(auth.jwt() ->> 'client_id', '');
$$;

create or replace function private.linked_agent_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select l.agent_id from public.agent_oauth_links l
  join public.agents a on a.id = l.agent_id
  where private.principal_type() = 'human'
    and l.user_id = (select auth.uid())
    and l.client_id = private.jwt_client_id()
    and l.revoked_at is null
    and a.status = 'enabled' and a.revoked_at is null
    and coalesce((select (value)::boolean from private.app_flags where name = 'agents_enabled'), true);
$$;

create or replace function private.task_actor_agent_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(private.current_agent_id(), private.linked_agent_id());
$$;

create or replace function private.agent_can(p_page_id text, p_scope text)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive chain as (
    select p.id, p.parent_id, 0 as depth from public.pages p where p.id = p_page_id
    union all
    select p.id, p.parent_id, c.depth + 1 from chain c
    join public.pages p on p.id = c.parent_id where c.depth < 3
  )
  select exists (
    select 1 from public.agent_grants g
    join chain c on c.id = g.page_id
    where g.agent_id = private.current_agent_id()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > now())
      and (c.depth = 0 or g.inherit)
      and p_scope = any (g.scopes)
  );
$$;

-- SQL plugs (§III.14.1): final bodies.
create or replace function private.agent_can_read(p_page_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.agent_can(p_page_id, 'read');
$$;
create or replace function private.agent_can_write(p_page_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.agent_can(p_page_id, 'write');
$$;

-- Rate limit: one 60 s window per agent against agents.rate_limit_per_min.
create or replace function private.check_rate(p_agent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_limit int; v_count int; v_window timestamptz := date_trunc('minute', now());
begin
  select rate_limit_per_min into v_limit from public.agents where id = p_agent_id;
  if v_limit is null then return; end if;
  insert into private.rate_counters (agent_id, window_start, count) values (p_agent_id, v_window, 1)
    on conflict (agent_id, window_start) do update set count = private.rate_counters.count + 1
    returning count into v_count;
  if v_count > v_limit then
    raise exception using errcode = 'PT429', message = 'rate_limited',
      detail = jsonb_build_object('retry_after_s', 60 - extract(second from now())::int)::text;
  end if;
end $$;

-- Audit helper tolerant to audit_events arriving in 0004.
create or replace function private.audit(p_workspace_id uuid, p_action text, p_target jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if to_regclass('public.audit_events') is null then return; end if;
  execute 'insert into public.audit_events (workspace_id, actor_id, actor_type, run_id, action, target) values ($1, $2, $3, $4, $5, $6)'
    using p_workspace_id, (select auth.uid()), private.principal_type(), private.current_run_id(), p_action, coalesce(p_target, '{}'::jsonb);
end $$;

revoke execute on function private.current_agent_id() from public;
revoke execute on function private.jwt_client_id() from public;
revoke execute on function private.linked_agent_id() from public;
revoke execute on function private.task_actor_agent_id() from public;
revoke execute on function private.agent_can(text, text) from public;
revoke execute on function private.check_rate(uuid) from public;
revoke execute on function private.audit(uuid, text, jsonb) from public;
grant execute on function private.current_agent_id() to authenticated, anon;
grant execute on function private.jwt_client_id() to authenticated, anon;
grant execute on function private.linked_agent_id() to authenticated, anon;
grant execute on function private.task_actor_agent_id() to authenticated, anon;
grant execute on function private.agent_can(text, text) to authenticated, anon;

-- ============ RLS ============

alter table public.agents enable row level security;
alter table public.agent_grants enable row level security;
alter table public.agent_tokens enable row level security;
alter table public.agent_oauth_links enable row level security;

create policy "members or self read agents" on public.agents for select to authenticated
  using ( private.is_human_member(workspace_id) or (private.is_agent() and auth_user_id = (select auth.uid())) );

create policy "editors or self read grants" on public.agent_grants for select to authenticated
  using ( private.is_human_editor(workspace_id) or agent_id = private.current_agent_id() );

-- agent_tokens: no direct SELECT for anyone; editors read through the view below.

create policy "self read oauth links" on public.agent_oauth_links for select to authenticated
  using ( user_id = (select auth.uid()) and private.principal_type() = 'human' );

create view public.agent_tokens_safe with (security_invoker = false) as
  select id, workspace_id, agent_id, name, token_prefix, scopes, expires_at, last_used_at, created_by, created_at, revoked_at
  from public.agent_tokens t
  where private.is_human_editor(t.workspace_id);
revoke all on public.agent_tokens_safe from public, anon;
grant select on public.agent_tokens_safe to authenticated;

-- ============ RPC: identity ============

create or replace function public.create_agent(
  p_workspace_id uuid, p_created_by uuid, p_auth_user_id uuid, p_name text, p_kind text,
  p_role text default 'worker', p_sponsor_user_id uuid default null, p_capabilities jsonb default '{}'::jsonb,
  p_connection jsonb default '{}'::jsonb, p_monthly_budget_usd numeric default null, p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sponsor uuid := coalesce(p_sponsor_user_id, p_created_by); v_id uuid; v_bad text;
begin
  if not exists (
      select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = p_created_by and m.role in ('owner','editor'))
     and not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = p_created_by) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = v_sponsor)
     and not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = v_sponsor) then
    raise exception using errcode = 'PT422', message = 'sponsor_not_member';
  end if;
  if jsonb_typeof(p_capabilities) <> 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select key into v_bad from jsonb_each(p_capabilities)
   where key not in ('start','continue','cancel','events','approval','cost','files') or jsonb_typeof(value) <> 'boolean' limit 1;
  if v_bad is not null then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = jsonb_build_object('capability', v_bad)::text;
  end if;
  insert into public.agents (id, workspace_id, auth_user_id, name, kind, role, sponsor_user_id, capabilities, connection, monthly_budget_usd, created_by)
  values (coalesce(p_id, gen_random_uuid()), p_workspace_id, p_auth_user_id, p_name, p_kind, coalesce(p_role, 'worker'), v_sponsor,
          coalesce(p_capabilities, '{}'::jsonb), coalesce(p_connection, '{}'::jsonb), p_monthly_budget_usd, p_created_by)
  returning id into v_id;
  perform private.audit(p_workspace_id, 'agent.create', jsonb_build_object('agent_id', v_id, 'created_by', p_created_by));
  return jsonb_build_object('agent_id', v_id);
end $$;
revoke all on function public.create_agent(uuid, uuid, uuid, text, text, text, uuid, jsonb, jsonb, numeric, uuid) from public, anon, authenticated;

create or replace function public.update_agent(p_agent_id uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_bad text;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
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
revoke all on function public.update_agent(uuid, jsonb) from public, anon;
grant execute on function public.update_agent(uuid, jsonb) to authenticated;

create or replace function public.add_agent_member(p_agent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid())) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (v_a.workspace_id, v_a.auth_user_id, 'viewer', (select auth.uid()))
  on conflict (workspace_id, user_id) do nothing;
end $$;
revoke all on function public.add_agent_member(uuid) from public, anon;
grant execute on function public.add_agent_member(uuid) to authenticated;

create or replace function public.grant_agent_page(p_agent_id uuid, p_page_id text, p_scopes text[], p_inherit boolean default true, p_expires_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_ws uuid; v_id uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id and revoked_at is null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select workspace_id into v_ws from public.pages where id = p_page_id and deleted_at is null;
  if v_ws is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.can_edit_workspace(v_ws) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if v_ws <> v_a.workspace_id then raise exception using errcode = 'PT422', message = 'cross_workspace'; end if;
  insert into public.agent_grants (workspace_id, agent_id, page_id, scopes, inherit, granted_by, expires_at)
  values (v_ws, p_agent_id, p_page_id, p_scopes, p_inherit, (select auth.uid()), p_expires_at)
  on conflict (agent_id, page_id) do update
    set scopes = excluded.scopes, inherit = excluded.inherit, expires_at = excluded.expires_at,
        granted_by = excluded.granted_by, revoked_at = null
  returning id into v_id;
  perform private.audit(v_ws, 'grant.add', jsonb_build_object('grant_id', v_id, 'agent_id', p_agent_id, 'page_id', p_page_id, 'scopes', to_jsonb(p_scopes)));
  return v_id;
end $$;
revoke all on function public.grant_agent_page(uuid, text, text[], boolean, timestamptz) from public, anon;
grant execute on function public.grant_agent_page(uuid, text, text[], boolean, timestamptz) to authenticated;

create or replace function public.revoke_agent_grant(p_grant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_g public.agent_grants%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_g from public.agent_grants where id = p_grant_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.can_edit_workspace(v_g.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  update public.agent_grants set revoked_at = now() where id = p_grant_id;
  perform private.audit(v_g.workspace_id, 'grant.revoke', jsonb_build_object('grant_id', p_grant_id));
end $$;
revoke all on function public.revoke_agent_grant(uuid) from public, anon;
grant execute on function public.revoke_agent_grant(uuid) to authenticated;

-- Token helpers (private).
create or replace function private.agent_token_pepper()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select value into v from private.app_secrets where name = 'agent_token_pepper';
  if v is null or v = '' then raise exception using errcode = 'PT500', message = 'misconfigured', detail = 'agent_token_pepper missing'; end if;
  return v;
end $$;
revoke execute on function private.agent_token_pepper() from public;

create or replace function private.hash_agent_token(p_token text)
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.digest(convert_to(private.agent_token_pepper() || p_token, 'utf8'), 'sha256'), 'hex');
$$;
revoke execute on function private.hash_agent_token(text) from public;

create or replace function private.random_base62(p_len int)
returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (get_byte(b, i) % 62) + 1, 1), '')
  from extensions.gen_random_bytes(p_len) b, generate_series(0, p_len - 1) i;
$$;
revoke execute on function private.random_base62(int) from public;

create or replace function public.issue_agent_token(p_agent_id uuid, p_name text default 'default', p_scopes text[] default array['mcp']::text[], p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype; v_token text; v_id uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id and revoked_at is null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
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

create or replace function public.revoke_agent_token(p_token_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tokens%rowtype; v_a public.agents%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_t from public.agent_tokens where id = p_token_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select * into v_a from public.agents where id = v_t.agent_id;
  if not (v_a.sponsor_user_id = (select auth.uid()) or exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid()))) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  update public.agent_tokens set revoked_at = now() where id = p_token_id;
  perform private.audit(v_t.workspace_id, 'token.revoke', jsonb_build_object('token_id', p_token_id));
end $$;
revoke all on function public.revoke_agent_token(uuid) from public, anon;
grant execute on function public.revoke_agent_token(uuid) to authenticated;

-- P1 version: disables the agent and its tokens. 0006 replaces it with run cancellation and task reassignment.
create or replace function public.revoke_agent(p_agent_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_a public.agents%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_a from public.agents where id = p_agent_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not exists (select 1 from public.workspaces w where w.id = v_a.workspace_id and w.owner_id = (select auth.uid())) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  update public.agents set status = 'disabled', revoked_at = coalesce(revoked_at, now()), updated_at = now() where id = p_agent_id;
  update public.agent_tokens set revoked_at = coalesce(revoked_at, now()) where agent_id = p_agent_id;
  update public.agent_grants set revoked_at = coalesce(revoked_at, now()) where agent_id = p_agent_id;
  perform private.audit(v_a.workspace_id, 'agent.revoke', jsonb_build_object('agent_id', p_agent_id, 'reason', p_reason));
end $$;
revoke all on function public.revoke_agent(uuid, text) from public, anon;
grant execute on function public.revoke_agent(uuid, text) to authenticated;

-- service_role only: PAT exchange support for the agent-token Edge Function.
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
  update public.agent_tokens set last_used_at = now() where id = v_t.id;
  return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id, 'workspace_id', v_a.workspace_id, 'scopes', to_jsonb(v_t.scopes), 'token_id', v_t.id);
end $$;
revoke all on function public.lookup_agent_token(text) from public, anon, authenticated;

create or replace function public.agent_token_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('pepper', private.agent_token_pepper());
$$;
revoke all on function public.agent_token_config() from public, anon, authenticated;

create or replace function public.set_app_flag(p_name text, p_value jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_admins text;
begin
  if current_setting('request.jwt.claims', true) is not null and current_setting('request.jwt.claims', true) <> ''
     and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') <> 'service_role' then
    select value into v_admins from private.app_secrets where name = 'platform_admins';
    if v_admins is null or (select auth.uid()) is null or position((select auth.uid())::text in v_admins) = 0 then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
  end if;
  insert into private.app_flags (name, value, updated_at, updated_by) values (p_name, p_value, now(), (select auth.uid()))
  on conflict (name) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
end $$;
revoke all on function public.set_app_flag(text, jsonb) from public, anon;
grant execute on function public.set_app_flag(text, jsonb) to authenticated;

create or replace function public.pause_workspace_agents(p_workspace_id uuid, p_paused boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = (select auth.uid())) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  update public.agents set status = case when p_paused then 'paused' else 'enabled' end, updated_at = now()
   where workspace_id = p_workspace_id and status <> 'disabled';
  get diagnostics v_n = row_count;
  perform private.audit(p_workspace_id, 'agents.pause', jsonb_build_object('paused', p_paused, 'count', v_n));
  return v_n;
end $$;
revoke all on function public.pause_workspace_agents(uuid, boolean) from public, anon;
grant execute on function public.pause_workspace_agents(uuid, boolean) to authenticated;

create or replace function public.whoami()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('uid', (select auth.uid()), 'principal_type', private.principal_type(),
                            'agent_id', private.current_agent_id(), 'client_id', private.jwt_client_id());
$$;
revoke all on function public.whoami() from public;
grant execute on function public.whoami() to authenticated, anon;
