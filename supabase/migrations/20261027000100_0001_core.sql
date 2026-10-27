-- =============================================================================
-- 0001_schema.sql — esquema completo de la capa de nube
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ============ tablas ============

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Workspace',
  owner_id uuid not null references auth.users(id) on delete cascade,
  root_order jsonb not null default '[]'::jsonb,
  synced_blocks jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','editor','viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.pages (
  id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_id text,
  data jsonb,                         -- null + deleted_at ⇒ tombstone
  published boolean not null default false,
  revision bigint not null default 0,
  last_edited_by uuid references auth.users(id) on delete set null,
  last_edited_by_type text check (last_edited_by_type in ('human','agent','system')),
  last_edit_run_id uuid,
  title text,
  search_tsv tsvector,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pages_workspace_idx on public.pages (workspace_id, updated_at desc);
create index pages_parent_idx on public.pages (parent_id);

create table public.page_shares (
  page_id text not null references public.pages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  level text not null check (level in ('view','comment','edit')),
  created_at timestamptz not null default now(),
  primary key (page_id, user_id)
);

create table public.reminders (
  id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  page_id text,
  block_id text,
  body text not null default '',
  remind_at timestamptz not null,
  notified boolean not null default false,
  deleted_at timestamptz,             -- tombstone
  created_at timestamptz not null default now()
);
create index reminders_due_idx on public.reminders (user_id, remind_at) where not notified;

create table public.files (
  created_by uuid references auth.users(id) on delete set null,
  created_by_type text check (created_by_type in ('human','agent','system')),
  id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

create table private.app_secrets (
  name       text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);
alter table private.app_secrets enable row level security;   -- sin policies: solo roles que saltan RLS
revoke all on private.app_secrets from public, anon, authenticated;

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor','viewer')),
  token_hash text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.page_files (
  page_id text not null references public.pages(id) on delete cascade,
  file_id text not null,
  primary key (page_id, file_id)
);
create index page_files_file_id_idx on public.page_files(file_id);
create index pages_search_idx on public.pages using gin(search_tsv);
create index pages_last_edit_run_idx on public.pages(last_edit_run_id) where last_edit_run_id is not null;
create table private.app_flags (
  name text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into private.app_flags(name, value) values ('agents_enabled', 'true');
create table private.write_receipts (
  scope text not null,
  key text not null,
  actor_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(scope, key, actor_id)
);
alter table private.app_flags enable row level security;
alter table private.write_receipts enable row level security;
revoke all on private.app_flags, private.write_receipts from public, anon, authenticated;

create or replace function private.principal_type()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'principal_type', ''),
    case when (select auth.uid()) is null then 'anon' else 'human' end
  );
$$;
create or replace function private.is_agent()
returns boolean language sql stable set search_path = '' as $$
  select private.principal_type() = 'agent';
$$;
create or replace function private.current_run_id()
returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('app.run_id', true), '')::uuid;
$$;
create or replace function private.is_workspace_member(ws uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select private.principal_type() = 'human' and (
    exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()))
    or exists (select 1 from public.workspaces w where w.id = ws and w.owner_id = (select auth.uid()))
  );
$$;
create or replace function private.can_edit_workspace(ws uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select private.principal_type() = 'human' and (
    exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role in ('owner','editor'))
    or exists (select 1 from public.workspaces w where w.id = ws and w.owner_id = (select auth.uid()))
  );
$$;
create or replace function private.is_human_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.principal_type() = 'human' and private.is_workspace_member(ws);
$$;
create or replace function private.is_human_editor(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.principal_type() = 'human' and private.can_edit_workspace(ws);
$$;
create or replace function private.has_page_share(p_page_id text, p_levels text[])
returns boolean language sql security definer set search_path = '' stable as $$
  select private.principal_type() = 'human' and exists (
    select 1 from public.page_shares s where s.page_id = p_page_id and s.user_id = (select auth.uid()) and s.level = any(p_levels)
  );
$$;
create or replace function private.page_workspace(p_page_id text)
returns uuid language sql security definer set search_path = '' stable as $$
  select workspace_id from public.pages where id = p_page_id;
$$;
create or replace function private.agent_can_read(p_page_id text)
returns boolean language sql stable security definer set search_path = '' as $$ select false; $$;
create or replace function private.agent_can_write(p_page_id text)
returns boolean language sql stable security definer set search_path = '' as $$ select false; $$;
create or replace function private.can_read_page(p_page_id text, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case private.principal_type()
    when 'human' then private.is_workspace_member(p_ws) or private.has_page_share(p_page_id, array['view','comment','edit'])
    when 'agent' then private.agent_can_read(p_page_id)
    else false end;
$$;
create or replace function private.can_write_page(p_page_id text, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case private.principal_type()
    when 'human' then private.can_edit_workspace(p_ws) or private.has_page_share(p_page_id, array['edit'])
    when 'agent' then private.agent_can_write(p_page_id)
    else false end;
$$;

create or replace function private.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger workspaces_touch before insert or update on public.workspaces for each row execute function private.touch_updated_at();
create trigger pages_touch before update on public.pages for each row execute function private.touch_updated_at();
create trigger pages_touch_insert before insert on public.pages for each row execute function private.touch_updated_at();
create or replace function private.protect_workspace_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id and old.owner_id is distinct from (select auth.uid()) then
    raise exception using errcode = 'PT403', message = 'only_owner_can_transfer';
  end if;
  return new;
end;
$$;
create trigger workspaces_protect_owner before update on public.workspaces for each row execute function private.protect_workspace_owner();
create or replace function private.protect_page_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_edit_workspace(old.workspace_id) and (
    new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
    or new.parent_id is distinct from old.parent_id or new.published is distinct from old.published
    or new.deleted_at is distinct from old.deleted_at or new.created_at is distinct from old.created_at
  ) then raise exception using errcode = 'PT403', message = 'protected_page_columns'; end if;
  return new;
end;
$$;
create trigger pages_10_protect_columns before update on public.pages for each row execute function private.protect_page_columns();

-- pages_20_revision: guardia de escritura + revisión (D20) [DOC+]
create or replace function private.check_page_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.data is not null and old.data is not null and new.data is distinct from old.data
     and coalesce(current_setting('app.ops_write', true), '') <> '1' then
    raise exception using errcode = 'PT403', message = 'use_apply_page_ops',
      detail = jsonb_build_object('page_id', old.id, 'revision', old.revision)::text;
  end if;
  if new.data is distinct from old.data
     or new.parent_id is distinct from old.parent_id
     or new.deleted_at is distinct from old.deleted_at
     or new.published is distinct from old.published then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;   -- escrituras que no tocan contenido no consumen revisión
  end if;
  return new;
end $$;
create trigger pages_20_revision before update on public.pages
  for each row execute function private.check_page_revision();

-- pages_30_actor: atribución sellada en el servidor [DOC]
create or replace function private.stamp_page_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.last_edited_by := (select auth.uid());
  new.last_edited_by_type := private.principal_type();
  new.last_edit_run_id := private.current_run_id();   -- null salvo dentro de una RPC de agente
  if tg_op = 'INSERT' then new.revision := 1; end if;
  return new;
end $$;
create trigger pages_30_actor before insert or update on public.pages
  for each row execute function private.stamp_page_actor();

create or replace function private.check_workspace_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.root_order is distinct from old.root_order or new.synced_blocks is distinct from old.synced_blocks or new.settings is distinct from old.settings then
    if coalesce(current_setting('app.ops_write', true), '') <> '1' then
      raise exception using errcode = 'PT403', message = 'use_apply_workspace_ops';
    end if;
    new.revision := old.revision + 1;
  else new.revision := old.revision;
  end if;
  return new;
end;
$$;
create trigger workspaces_20_revision before update on public.workspaces for each row execute function private.check_workspace_revision();

create or replace function private.page_text(p_data jsonb)
returns text language sql immutable set search_path = '' as $$
  with recursive blocks(value) as (
    select value from jsonb_array_elements(coalesce(p_data->'blocks', '[]'))
    union all
    select child.value from blocks b
      cross join lateral jsonb_array_elements(coalesce(b.value->'columns', '[]')) c
      cross join lateral jsonb_array_elements(coalesce(c->'blocks', '[]')) child
  ), pieces(value) as (
    select coalesce(p_data->>'title', '')
    union all select coalesce(value->>'html', '') from blocks
    union all select cell #>> '{}' from blocks b
      cross join lateral jsonb_array_elements(coalesce(b.value->'table', '[]')) r
      cross join lateral jsonb_array_elements(r) cell
    union all select c.value::text from jsonb_array_elements(coalesce(p_data->'database'->'rows', '[]')) r
      cross join lateral jsonb_each(coalesce(r->'cells', '{}')) c
  ) select regexp_replace(coalesce(string_agg(value, ' '), ''), '<[^>]*>', '', 'g') from pieces;
$$;
create or replace function private.maintain_page_search()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.title := new.data->>'title';
  new.search_tsv := to_tsvector('simple', private.page_text(new.data));
  return new;
end;
$$;
create trigger maintain_page_search before insert or update on public.pages for each row execute function private.maintain_page_search();
create or replace function private.maintain_page_files()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.page_files where page_id = new.id;
  if new.data is not null then
    insert into public.page_files(page_id, file_id)
    select distinct new.id, value #>> '{}' from jsonb_path_query(new.data, '$.**.fileId') as referenced(value)
    where jsonb_typeof(value) = 'string' and length(value #>> '{}') > 0
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger maintain_page_files after insert or update on public.pages for each row execute function private.maintain_page_files();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.pages enable row level security;
alter table public.page_shares enable row level security;
alter table public.page_files enable row level security;
alter table public.files enable row level security;
alter table public.reminders enable row level security;
alter table public.push_subscriptions enable row level security;
revoke all on public.workspaces, public.workspace_members, public.workspace_invitations, public.pages, public.page_shares, public.page_files, public.files, public.reminders, public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.workspaces, public.workspace_members, public.workspace_invitations, public.pages, public.page_shares, public.files, public.reminders, public.push_subscriptions to authenticated;
grant select on public.pages, public.files, public.page_files to anon;
grant select on public.page_files to authenticated;

create policy "members read workspace" on public.workspaces for select to authenticated
using (private.principal_type() = 'human' and (owner_id = (select auth.uid()) or private.is_human_member(id)));
create policy "owner inserts workspace" on public.workspaces for insert to authenticated
with check (owner_id = (select auth.uid()) and private.principal_type() = 'human');
create policy "editors update workspace" on public.workspaces for update to authenticated
using (private.is_human_editor(id)) with check (private.is_human_editor(id));
create policy "owner deletes workspace" on public.workspaces for delete to authenticated
using (private.principal_type() = 'human' and owner_id = (select auth.uid()));

create policy "members read members" on public.workspace_members for select to authenticated using (private.is_human_member(workspace_id));
create policy "owner inserts members" on public.workspace_members for insert to authenticated with check (
  private.principal_type() = 'human' and exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid()))
);
create policy "owner updates members" on public.workspace_members for update to authenticated
using (private.principal_type() = 'human' and exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())))
with check (private.principal_type() = 'human' and exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "owner or self removes member" on public.workspace_members for delete to authenticated using (
  private.principal_type() = 'human' and (user_id = (select auth.uid()) or exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())))
);
create policy "read invitations" on public.workspace_invitations for select to authenticated using (
  private.principal_type() = 'human' and (private.is_human_editor(workspace_id) or lower(email) = lower(auth.jwt()->>'email'))
);
create policy "editors insert invitations" on public.workspace_invitations for insert to authenticated with check (private.is_human_editor(workspace_id));
create policy "owner updates invitations" on public.workspace_invitations for update to authenticated
using (private.principal_type() = 'human' and exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())))
with check (private.principal_type() = 'human' and exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "owner deletes invitations" on public.workspace_invitations for delete to authenticated
using (private.principal_type() = 'human' and exists(select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));

create policy "read authorized pages" on public.pages for select to authenticated using (published or private.can_read_page(id, workspace_id));
create policy "read published pages" on public.pages for select to anon using (published);
create policy "editors insert pages" on public.pages for insert to authenticated with check (private.is_human_editor(workspace_id));
create policy "writers update pages" on public.pages for update to authenticated using (private.can_write_page(id, workspace_id)) with check (private.can_write_page(id, workspace_id));
create policy "editors delete pages" on public.pages for delete to authenticated using (private.is_human_editor(workspace_id));

create policy "involved read shares" on public.page_shares for select to authenticated using (
  private.principal_type() = 'human' and (user_id = (select auth.uid()) or private.is_human_editor(private.page_workspace(page_id)))
);
create policy "editors insert shares" on public.page_shares for insert to authenticated with check (private.is_human_editor(private.page_workspace(page_id)));
create policy "editors update shares" on public.page_shares for update to authenticated
using (private.is_human_editor(private.page_workspace(page_id))) with check (private.is_human_editor(private.page_workspace(page_id)));
create policy "editors or self delete shares" on public.page_shares for delete to authenticated
using (private.principal_type() = 'human' and (user_id = (select auth.uid()) or private.is_human_editor(private.page_workspace(page_id))));
create policy "page readers resolve files" on public.page_files for select to anon, authenticated
using (exists(select 1 from public.pages p where p.id = page_id and (p.published or private.can_read_page(p.id, p.workspace_id))));
create policy "anyone resolves file location" on public.files for select to anon, authenticated using (true);
create policy "editors register files" on public.files for insert to authenticated with check (private.is_human_editor(workspace_id));
create policy "editors update files" on public.files for update to authenticated using (private.is_human_editor(workspace_id)) with check (private.is_human_editor(workspace_id));
create policy "editors delete files" on public.files for delete to authenticated using (private.is_human_editor(workspace_id));
create policy "own reminders select" on public.reminders for select to authenticated using (private.principal_type() = 'human' and user_id = (select auth.uid()));
create policy "own reminders insert" on public.reminders for insert to authenticated with check (private.principal_type() = 'human' and user_id = (select auth.uid()) and private.is_human_member(workspace_id));
create policy "own reminders update" on public.reminders for update to authenticated
using (private.principal_type() = 'human' and user_id = (select auth.uid())) with check (private.principal_type() = 'human' and user_id = (select auth.uid()));
create policy "own reminders delete" on public.reminders for delete to authenticated using (private.principal_type() = 'human' and user_id = (select auth.uid()));
create policy "own push subscriptions select" on public.push_subscriptions for select to authenticated using (private.principal_type() = 'human' and user_id = (select auth.uid()));
create policy "own push subscriptions insert" on public.push_subscriptions for insert to authenticated with check (private.principal_type() = 'human' and user_id = (select auth.uid()));
create policy "own push subscriptions update" on public.push_subscriptions for update to authenticated
using (private.principal_type() = 'human' and user_id = (select auth.uid())) with check (private.principal_type() = 'human' and user_id = (select auth.uid()));
create policy "own push subscriptions delete" on public.push_subscriptions for delete to authenticated using (private.principal_type() = 'human' and user_id = (select auth.uid()));

insert into storage.buckets(id, name, public) values ('files', 'files', false) on conflict(id) do nothing;
create policy "members read files" on storage.objects for select to authenticated
using (bucket_id = 'files' and private.is_human_member((split_part(name, '/', 1))::uuid));
create policy "editors upload files" on storage.objects for insert to authenticated
with check (bucket_id = 'files' and private.is_human_editor((split_part(name, '/', 1))::uuid));
create policy "editors update files" on storage.objects for update to authenticated
using (bucket_id = 'files' and private.is_human_editor((split_part(name, '/', 1))::uuid))
with check (bucket_id = 'files' and private.is_human_editor((split_part(name, '/', 1))::uuid));
create policy "editors delete files" on storage.objects for delete to authenticated
using (bucket_id = 'files' and private.is_human_editor((split_part(name, '/', 1))::uuid));
create policy "page readers read files" on storage.objects for select to anon, authenticated using (
  bucket_id = 'files' and exists (
    select 1 from public.page_files pf join public.pages p on p.id = pf.page_id
    where pf.file_id = split_part(storage.objects.name, '/', 2)
      and p.workspace_id::text = split_part(storage.objects.name, '/', 1)
      and p.deleted_at is null and p.data is not null
      and (p.published or private.can_read_page(p.id, p.workspace_id))
  )
);

revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to anon, authenticated;
grant execute on function private.principal_type(), private.is_agent(), private.current_run_id(), private.is_workspace_member(uuid), private.can_edit_workspace(uuid), private.is_human_member(uuid), private.is_human_editor(uuid), private.has_page_share(text,text[]), private.page_workspace(text), private.can_read_page(text,uuid), private.can_write_page(text,uuid) to anon, authenticated;
alter publication supabase_realtime add table public.pages;
alter publication supabase_realtime add table public.workspaces;
