-- 0039 · Private pages: a page only its owner reaches, in the app.
--
-- Until now every workspace member read every page. A row here hides the page from everyone but its owner in a direct
-- session: other members, agents, chat sessions acting as the owner, and anyone holding a share. The rule lives in
-- the helpers every policy and RPC already call, so there is one check and no list of places to remember.
-- Being private does not stop the owner from publishing the page: a published page is public, as it is today.
--
-- Pages created or moved under a private page become private with the same owner. Moving one out keeps it private:
-- a wrong guess here leaks nothing. Only the owner turns it off.

create table public.private_pages (
  page_id       text primary key references public.pages(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  -- The page whose privacy this row follows; itself for the root of a private tree.
  root_page_id  text not null,
  created_at    timestamptz not null default now()
);
create index private_pages_root_idx on public.private_pages (root_page_id);
create index private_pages_owner_idx on public.private_pages (owner_user_id, workspace_id);

alter table public.private_pages enable row level security;
revoke all on public.private_pages from anon, authenticated;
grant select on public.private_pages to authenticated;
grant all on public.private_pages to service_role;
create policy "owner reads own private pages" on public.private_pages for select to authenticated
  using (owner_user_id = (select auth.uid()) and private.is_human_member(workspace_id));

-- True when this caller must not reach the page. A chat session acting as the owner stays out too: it could carry
-- what a page says to a model, and notes hold forwarded content.
create or replace function private.page_hidden(p_page_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.private_pages x
                  where x.page_id = p_page_id
                    and (x.owner_user_id is distinct from (select auth.uid()) or private.jwt_client_id() is not null));
$$;
revoke all on function private.page_hidden(text) from public;
grant execute on function private.page_hidden(text) to anon, authenticated;

-- Full latest definitions from 0001. Only the first line of each is new.
create or replace function private.can_read_page(p_page_id text, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.page_hidden(p_page_id) and case private.principal_type()
    when 'human' then private.is_workspace_member(p_ws) or private.has_page_share(p_page_id, array['view','comment','edit'])
    when 'agent' then private.agent_can_read(p_page_id)
    else false end;
$$;
create or replace function private.can_write_page(p_page_id text, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.page_hidden(p_page_id) and case private.principal_type()
    when 'human' then private.can_edit_workspace(p_ws) or private.has_page_share(p_page_id, array['edit'])
    when 'agent' then private.agent_can_write(p_page_id)
    else false end;
$$;

-- Full latest definition from 0002. Several RPCs call agent_can directly, so the grant lookup itself refuses.
create or replace function private.agent_can(p_page_id text, p_scope text)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive chain as (
    select p.id, p.parent_id, 0 as depth from public.pages p where p.id = p_page_id
    union all
    select p.id, p.parent_id, c.depth + 1 from chain c
    join public.pages p on p.id = c.parent_id where c.depth < 3
  )
  select not private.page_hidden(p_page_id) and exists (
    select 1 from public.agent_grants g
    join chain c on c.id = g.page_id
    where g.agent_id = private.current_agent_id()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > now())
      and (c.depth = 0 or g.inherit)
      and p_scope = any (g.scopes)
  );
$$;

-- Full latest definition from 0004. The platform agent keeps seeing requests delegated to it on a private page.
create or replace function private.can_see_task(p_ws uuid, p_row_page_id text, p_delegate uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case private.principal_type()
    when 'human' then not private.page_hidden(p_row_page_id)
                      and (private.is_human_member(p_ws) or private.has_page_share(p_row_page_id, array['view','comment','edit']))
    when 'agent' then (p_delegate is not null and p_delegate = private.current_agent_id()) or private.agent_can(p_row_page_id, 'read')
    else false end;
$$;

-- An editor can see no private page of someone else, and the delete policy of 0001 only asks for an editor.
create policy "private pages are deleted by their owner" on public.pages as restrictive for delete to authenticated
  using (not private.page_hidden(id));

-- ============ inheritance ============

-- A page and everything below it, with a depth limit that also ends a parent cycle.
create or replace function private.page_subtree(p_page_id text)
returns setof text language sql stable security definer set search_path = '' as $$
  with recursive tree as (
    select p.id, 0 as depth from public.pages p where p.id = p_page_id
    union all
    select p.id, t.depth + 1 from tree t join public.pages p on p.parent_id = t.id where t.depth < 32
  )
  select id from tree;
$$;
revoke all on function private.page_subtree(text) from public, anon, authenticated;

create or replace function private.inherit_private_page()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_parent public.private_pages%rowtype;
begin
  select * into v_parent from public.private_pages where page_id = new.parent_id;
  if found then
    insert into public.private_pages (page_id, workspace_id, owner_user_id, root_page_id)
    select id, v_parent.workspace_id, v_parent.owner_user_id, v_parent.root_page_id from private.page_subtree(new.id) id
    on conflict (page_id) do nothing;
  end if;
  return null;
end $$;
revoke all on function private.inherit_private_page() from public, anon, authenticated;
create trigger pages_inherit_private after insert on public.pages
  for each row when (new.parent_id is not null) execute function private.inherit_private_page();
create trigger pages_inherit_private_move after update of parent_id on public.pages
  for each row when (new.parent_id is not null and new.parent_id is distinct from old.parent_id)
  execute function private.inherit_private_page();

-- ============ what a bundle may include ============

-- Full latest definition from 0003. A public page may link to a private one: the walk must not carry it along.
-- Only the two loops that read other pages changed.
create or replace function public.get_page_bundle(p_page_id text, p_max_pages int default 200)
returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare
  v_max_depth constant int := 3;
  v_max_pages int := greatest(1, least(coalesce(p_max_pages, 200), 200));
  v_root       public.pages%rowtype;
  v_ws         uuid;
  v_full       jsonb := '{}'::jsonb;   -- id -> página completa (raíz incluida)
  v_links      jsonb := '{}'::jsonb;   -- id -> stub título/icono
  v_synced     jsonb := '{}'::jsonb;
  v_frontier   text[];
  v_next_full  text[];
  v_next_link  text[];
  v_keys       text[];
  v_truncated  boolean := false;
  v_count      int;
  d            int;
  rec          record;
begin
  select * into v_root
  from public.pages
  where id = p_page_id and deleted_at is null;

  if not found
     or v_root.data is null
     or coalesce((v_root.data->>'isDeleted')::boolean, false) then
    return null;
  end if;

  v_ws := v_root.workspace_id;

  -- ÚNICA comprobación de acceso: todo lo demás deriva de esta página
  if not (
    coalesce(v_root.published, false)
    or private.can_read_page(p_page_id, v_ws)
  ) then
    return null;
  end if;

  v_full := jsonb_build_object(p_page_id, private.strip_page(v_root.data));
  v_frontier := array[p_page_id];

  for d in 1..v_max_depth loop
    exit when coalesce(array_length(v_frontier, 1), 0) = 0;

    select coalesce(array_agg(distinct r.page_id) filter (where r.kind = 'full'), '{}'),
           coalesce(array_agg(distinct r.page_id) filter (where r.kind = 'link'), '{}')
      into v_next_full, v_next_link
    from unnest(v_frontier) fid,
         lateral private.page_refs(v_full -> fid) r;

    select coalesce(array_agg(x), '{}') into v_next_full
    from unnest(v_next_full) x
    where not (v_full ? x);

    v_frontier := '{}';

    if coalesce(array_length(v_next_full, 1), 0) > 0 then
      for rec in
        select p.id, p.data
        from public.pages p
        where p.id = any (v_next_full)
          and p.workspace_id = v_ws            -- nunca salir del workspace raíz
          and p.deleted_at is null
          and p.data is not null
          and coalesce((p.data->>'isDeleted')::boolean, false) = false
          and (p.published or not private.page_hidden(p.id))
        order by p.id
      loop
        select count(*) into v_count
        from jsonb_object_keys(v_full || v_links);
        if v_count >= v_max_pages then
          v_truncated := true;
          exit;
        end if;
        v_full := v_full || jsonb_build_object(rec.id, private.strip_page(rec.data));
        v_links := v_links - rec.id;         -- un stub se promociona a contenido completo
        v_frontier := v_frontier || rec.id;
      end loop;
    end if;

    -- enlaces a subpáginas: solo título/icono, nunca se recorren
    select coalesce(array_agg(x), '{}') into v_next_link
    from unnest(v_next_link) x
    where not (v_full ? x) and not (v_links ? x);

    if coalesce(array_length(v_next_link, 1), 0) > 0 and not v_truncated then
      for rec in
        select p.id, p.data
        from public.pages p
        where p.id = any (v_next_link)
          and p.workspace_id = v_ws
          and p.deleted_at is null
          and p.data is not null
          and coalesce((p.data->>'isDeleted')::boolean, false) = false
          and (p.published or not private.page_hidden(p.id))
        order by p.id
      loop
        select count(*) into v_count
        from jsonb_object_keys(v_full || v_links);
        if v_count >= v_max_pages then
          v_truncated := true;
          exit;
        end if;
        v_links := v_links || jsonb_build_object(rec.id, private.page_stub(rec.id, rec.data));
      end loop;
    end if;

    exit when v_truncated;
  end loop;

  -- contenido de bloques sincronizados referenciado por cualquier página incluida
  select coalesce(array_agg(distinct coalesce(b->>'syncedFrom', b->>'id')), '{}')
    into v_keys
  from jsonb_each(v_full) e,
       lateral private.all_blocks(e.value) b
  where b->>'type' = 'synced';

  if coalesce(array_length(v_keys, 1), 0) > 0 then
    select coalesce(jsonb_object_agg(k, w.synced_blocks -> k), '{}'::jsonb)
      into v_synced
    from public.workspaces w,
         unnest(v_keys) k
    where w.id = v_ws
      and jsonb_typeof(w.synced_blocks) = 'object'
      and w.synced_blocks ? k;
  end if;

  return jsonb_build_object(
    'page', (v_root.data - 'versions' - '_client'),   -- la raíz conserva sus comentarios
    'updatedAt', (extract(epoch from v_root.updated_at) * 1000)::bigint,
    'pages', (v_full - p_page_id) || v_links,
    'syncedBlocks', coalesce(v_synced, '{}'::jsonb),
    'truncated', v_truncated
  );
end;
$$;
revoke all on function public.get_page_bundle(text, int) from public;
grant execute on function public.get_page_bundle(text, int) to anon, authenticated;
