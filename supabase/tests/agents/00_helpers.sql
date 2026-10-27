-- Test helpers for the agent-layer pgTAP suites. This file commits its helpers (schema `tests`)
-- so the suites that follow (alphabetically) can use them. Runs as the superuser of the test database.
create extension if not exists pgtap with schema extensions;

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;
alter default privileges in schema tests grant execute on functions to anon, authenticated, service_role;

-- A confirmed auth user with a fixed email; returns its id (idempotent).
create or replace function tests.make_user(p_email text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
            extensions.crypt('demo-password', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());
  end if;
  return v_id;
end $$;

create or replace function tests.set_claims(p_claims jsonb, p_role text)
returns void language plpgsql as $$
begin
  reset role;
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_claims->>'sub', ''), true);
  perform set_config('request.jwt.claim.role', p_role, true);
end $$;

create or replace function tests.set_human(p_uid uuid, p_client_id text default null)
returns void language sql as $$
  select tests.set_claims(jsonb_strip_nulls(jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aud', 'authenticated',
    'email', 'user@test.local', 'app_metadata', '{}'::jsonb, 'client_id', p_client_id)), 'authenticated');
$$;

create or replace function tests.set_agent(p_uid uuid, p_agent_id uuid)
returns void language sql as $$
  select tests.set_claims(jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aud', 'authenticated',
    'app_metadata', jsonb_build_object('principal_type', 'agent', 'agent_id', p_agent_id)), 'authenticated');
$$;

create or replace function tests.set_anon()
returns void language sql as $$
  select tests.set_claims('{"role":"anon"}'::jsonb, 'anon');
$$;

create or replace function tests.set_service()
returns void language sql as $$
  select tests.set_claims('{"role":"service_role"}'::jsonb, 'service_role');
$$;

create or replace function tests.reset_role()
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Shared fixture: owner, viewer, workspace, page_A (with child page_A1), page_B, one agent with a grant on page_A.
-- Returns ids as jsonb. Call inside a transaction that rolls back.
create or replace function tests.fixture()
returns jsonb language plpgsql as $$
declare
  v_owner uuid := tests.make_user('owner@test.local');
  v_viewer uuid := tests.make_user('viewer@test.local');
  v_agent_user uuid := tests.make_user('agent+fixture@agents.invalid');
  v_ws uuid; v_agent uuid; v_grant uuid; v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into private.app_secrets (name, value) values ('agent_token_pepper', 'test-pepper') on conflict (name) do nothing;
  insert into public.workspaces (name, owner_id) values ('Test', v_owner) returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_owner, 'owner'), (v_ws, v_viewer, 'viewer');
  perform set_config('app.ops_write', '1', true);
  insert into public.pages (id, workspace_id, parent_id, data) values
    ('page_A', v_ws, null, jsonb_build_object('id', 'page_A', 'title', 'Page A', 'icon', null, 'cover', null, 'parentId', null,
       'blocks', jsonb_build_array(jsonb_build_object('id', 'blk_a1', 'type', 'paragraph', 'html', 'Hello A', 'indent', 0, 'rev', 1)),
       'isFavorite', false, 'isDeleted', false, 'fullWidth', false, 'smallText', false, 'createdAt', v_now, 'updatedAt', v_now)),
    ('page_A1', v_ws, 'page_A', jsonb_build_object('id', 'page_A1', 'title', 'Page A1', 'icon', null, 'cover', null, 'parentId', 'page_A',
       'blocks', '[]'::jsonb, 'isFavorite', false, 'isDeleted', false, 'fullWidth', false, 'smallText', false, 'createdAt', v_now, 'updatedAt', v_now)),
    ('page_B', v_ws, null, jsonb_build_object('id', 'page_B', 'title', 'Page B', 'icon', null, 'cover', null, 'parentId', null,
       'blocks', jsonb_build_array(jsonb_build_object('id', 'blk_b1', 'type', 'paragraph', 'html', 'Hello B', 'indent', 0, 'rev', 1)),
       'isFavorite', false, 'isDeleted', false, 'fullWidth', false, 'smallText', false, 'createdAt', v_now, 'updatedAt', v_now));
  insert into public.agents (workspace_id, auth_user_id, name, kind, sponsor_user_id, created_by)
  values (v_ws, v_agent_user, 'Fixture Agent', 'acp_local', v_owner, v_owner) returning id into v_agent;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_agent_user, 'viewer');
  insert into public.agent_grants (workspace_id, agent_id, page_id, scopes, inherit, granted_by)
  values (v_ws, v_agent, 'page_A', array['read','write','comment'], true, v_owner) returning id into v_grant;
  perform set_config('app.ops_write', '', true);
  return jsonb_build_object('owner', v_owner, 'viewer', v_viewer, 'agent_user', v_agent_user, 'ws', v_ws, 'agent', v_agent, 'grant', v_grant);
end $$;

-- Runs a statement and returns the SQLSTATE it raised ('' when it succeeded).
create or replace function tests.sqlstate_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlstate;
end $$;

-- Runs a statement and returns the error message it raised ('' when it succeeded).
create or replace function tests.error_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlerrm;
end $$;

select plan(1);
select pass('test helpers installed');
select * from finish();
