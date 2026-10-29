-- 0015_search: unaccent, comments in the page index, one search RPC with the SearchHit contract.
create extension if not exists unaccent with schema extensions;

create or replace function private.comments_text(p_data jsonb)
returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg(c->>'body', ' '), '') from jsonb_array_elements(coalesce(p_data->'comments', '[]')) c;
$$;
revoke all on function private.comments_text(jsonb) from public, anon, authenticated;

create or replace function private.page_search_tsv(p_data jsonb)
returns tsvector language sql stable set search_path = '' as $$
  select to_tsvector('simple', extensions.unaccent('extensions.unaccent'::regdictionary,
    private.page_text(p_data) || ' ' || private.comments_text(p_data)));
$$;
revoke all on function private.page_search_tsv(jsonb) from public, anon, authenticated;

create or replace function private.maintain_page_search()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.title := new.data->>'title';
  new.search_tsv := private.page_search_tsv(new.data);
  return new;
end;
$$;

-- Backfill. User triggers off: pages_touch would rewrite updated_at and pages_30_actor would erase attribution.
alter table public.pages disable trigger user;
update public.pages set search_tsv = private.page_search_tsv(data) where data is not null;
alter table public.pages enable trigger user;

create or replace function public.search_workspace(p_workspace_id uuid default null, p_query text default null, p_database_id text default null, p_limit int default 20)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_q tsquery; v_term text; v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_pages jsonb := '[]'; v_tasks jsonb := '[]';
begin
  if coalesce(btrim(p_query), '') = '' then return '[]'; end if;
  v_q := websearch_to_tsquery('simple', extensions.unaccent('extensions.unaccent'::regdictionary, p_query));
  if numnode(v_q) = 0 then return '[]'; end if;
  v_term := lower(extensions.unaccent('extensions.unaccent'::regdictionary, split_part(btrim(p_query), ' ', 1)));
  select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(h))), '[]') into v_pages from (
    select case when parent.data->'database' is not null then 'row' else 'page' end as kind,
           p.id, p.id as "pageId",
           (select b->>'id' from jsonb_array_elements(coalesce(p.data->'blocks', '[]')) b
             where position(v_term in lower(extensions.unaccent('extensions.unaccent'::regdictionary,
               regexp_replace(coalesce(b->>'html', ''), '<[^>]*>', '', 'g')))) > 0 limit 1) as "blockId",
           coalesce(p.title, '') as title,
           ts_headline('simple', extensions.unaccent('extensions.unaccent'::regdictionary, private.page_text(p.data)), v_q, 'MaxFragments=1, MaxWords=20, MinWords=6') as snippet,
           ts_rank(p.search_tsv, v_q)::float8 as score
    from public.pages p left join public.pages parent on parent.id = p.parent_id
    where (p_workspace_id is null or p.workspace_id = p_workspace_id) and p.deleted_at is null and p.data is not null
      and (p_database_id is null or p.parent_id = p_database_id)
      and p.search_tsv @@ v_q
    order by ts_rank(p.search_tsv, v_q) desc limit v_limit
  ) h;
  if p_database_id is null then
    select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(h))), '[]') into v_tasks from (
      select 'task' as kind, t.id::text as id, t.row_page_id as "pageId", null::text as "blockId", t.title,
             ts_headline('simple', t.title, v_q) as snippet,
             ts_rank(to_tsvector('simple', extensions.unaccent('extensions.unaccent'::regdictionary, t.title)), v_q)::float8 as score
      from public.agent_tasks t
      where (p_workspace_id is null or t.workspace_id = p_workspace_id)
        and to_tsvector('simple', extensions.unaccent('extensions.unaccent'::regdictionary, t.title)) @@ v_q
      order by score desc limit v_limit
    ) h;
  end if;
  return (select coalesce(jsonb_agg(value order by (value->>'score')::float8 desc), '[]') from (
    select value from jsonb_array_elements(v_pages || v_tasks) order by (value->>'score')::float8 desc limit v_limit) s);
end;
$$;
revoke all on function public.search_workspace(uuid,text,text,int) from public;
grant execute on function public.search_workspace(uuid,text,text,int) to anon, authenticated;

create or replace function public.search_pages(p_query text, p_limit int default 10, p_kind text default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb; v_limit int := greatest(1,least(coalesce(p_limit,10),20));
  v_q tsquery := plainto_tsquery('simple', extensions.unaccent('extensions.unaccent'::regdictionary, p_query));
begin
  if p_kind = 'task' then
    if to_regclass('public.agent_tasks') is null then return '[]'; end if;
    execute 'select coalesce(jsonb_agg(to_jsonb(r)),''[]'') from (select id,title,''/p/''||row_page_id as url,ts_headline(''simple'',title,$1) as snippet,''task'' as kind,updated_at from public.agent_tasks where to_tsvector(''simple'',extensions.unaccent(''extensions.unaccent''::regdictionary,title)) @@ $1 order by ts_rank(to_tsvector(''simple'',extensions.unaccent(''extensions.unaccent''::regdictionary,title)),$1) desc limit $2) r' into v_result using v_q,v_limit;
    return v_result;
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)),'[]') into v_result from (
    select id,title,'/p/'||id as url,ts_headline('simple',private.page_text(data),v_q) as snippet,'page' as kind,updated_at
    from public.pages where deleted_at is null and search_tsv @@ v_q
    order by ts_rank(search_tsv,v_q) desc limit v_limit
  ) r;
  return v_result;
end;
$$;
revoke all on function public.search_pages(text,int,text) from public;
grant execute on function public.search_pages(text,int,text) to anon,authenticated;
