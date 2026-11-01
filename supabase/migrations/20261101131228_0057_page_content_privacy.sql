-- 0057: Page authorization also protects derived content and task decisions.
-- Canonical synced content must never be broadcast in the workspace row.
create table private.workspace_synced_blocks (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  source_page_id text references public.pages(id) on delete set null,
  blocks jsonb not null,
  primary key (workspace_id, key)
);
create index workspace_synced_blocks_source_idx on private.workspace_synced_blocks(source_page_id);
alter table private.workspace_synced_blocks enable row level security;
revoke all on private.workspace_synced_blocks from public, anon, authenticated;

-- Bind once to the original page, never to an arbitrary copy with the same block id.
-- Ambiguous/orphan legacy entries are retained but fail closed until repaired by an administrator.
insert into private.workspace_synced_blocks(workspace_id,key,source_page_id,blocks)
select w.id,e.key,
  (select case when count(distinct p.id)=1 then min(p.id) end
   from public.pages p,lateral private.all_blocks(p.data) b
   where p.workspace_id=w.id and b->>'type'='synced' and b->>'id'=e.key
     and nullif(b->>'syncedFrom','') is null), e.value
from public.workspaces w,lateral jsonb_each(w.synced_blocks) e;
select set_config('app.ops_write','1',true);
update public.workspaces set synced_blocks='{}' where synced_blocks<>'{}'::jsonb;
select set_config('app.ops_write','',true);
alter table public.workspaces add constraint synced_content_is_private check (synced_blocks='{}'::jsonb);

create or replace function private.check_workspace_revision()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.synced_blocks<>'{}'::jsonb then
    raise exception using errcode='PT403',message='use_apply_workspace_ops';
  end if;
  if new.root_order is distinct from old.root_order or new.settings is distinct from old.settings
     or coalesce(current_setting('app.synced_write',true),'')='1' then
    if coalesce(current_setting('app.ops_write',true),'')<>'1' then
      raise exception using errcode='PT403',message='use_apply_workspace_ops';
    end if;
    new.revision:=old.revision+1;
  else new.revision:=old.revision; end if;
  return new;
end $$;

create or replace function private.read_synced_blocks(p_ws uuid, p_keys text[] default null, p_bundle boolean default false)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(s.key,s.blocks),'{}'::jsonb)
  from private.workspace_synced_blocks s join public.pages p on p.id=s.source_page_id
  where s.workspace_id=p_ws and p.workspace_id=p_ws and p.data is not null and p.deleted_at is null
    and (p_keys is null or s.key=any(p_keys))
    and (private.can_read_page(p.id,p.workspace_id) or p.published
      or (p_bundle and not exists(select 1 from public.private_pages x where x.page_id=p.id)));
$$;
revoke all on function private.read_synced_blocks(uuid,text[],boolean) from public,anon,authenticated;

create or replace function public.read_workspace_synced_blocks(p_workspace_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select private.read_synced_blocks(p_workspace_id);
$$;
revoke all on function public.read_workspace_synced_blocks(uuid) from public,anon;
grant execute on function public.read_workspace_synced_blocks(uuid) to authenticated;

-- Keep the legacy page expansion rules in one implementation, behind an unexposed helper.
alter function public.get_page_bundle(text,int) set schema private;
alter function private.get_page_bundle(text,int) rename to page_bundle_base;
revoke all on function private.page_bundle_base(text,int) from public,anon,authenticated;
create function public.get_page_bundle(p_page_id text,p_max_pages int default 200)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b jsonb; keys text[]; ws uuid;
begin
  b:=private.page_bundle_base(p_page_id,p_max_pages);
  if b is null then return null; end if;
  select workspace_id into ws from public.pages where id=p_page_id;
  select array_agg(distinct coalesce(bl->>'syncedFrom',bl->>'id')) into keys
  from jsonb_each((b->'pages')||jsonb_build_object(p_page_id,b->'page')) e,
       lateral private.all_blocks(e.value) bl where bl->>'type'='synced';
  return jsonb_set(b,'{syncedBlocks}',private.read_synced_blocks(ws,coalesce(keys,'{}'),true));
end $$;
revoke all on function public.get_page_bundle(text,int) from public;
grant execute on function public.get_page_bundle(text,int) to anon,authenticated;

-- A page's publication/privacy/archival change invalidates every member's filtered cache,
-- even if RLS hides that page's own Realtime event from the member.
create function private.invalidate_synced_workspace()
returns trigger language plpgsql security definer set search_path='' as $$
declare ws uuid; prior_ops text:=current_setting('app.ops_write',true); prior_sync text:=current_setting('app.synced_write',true);
begin
  ws:=case when tg_op='DELETE' then old.workspace_id else new.workspace_id end;
  perform set_config('app.ops_write','1',true);
  perform set_config('app.synced_write','1',true);
  update public.workspaces set revision=revision+1 where id=ws;
  perform set_config('app.ops_write',coalesce(prior_ops,''),true);
  perform set_config('app.synced_write',coalesce(prior_sync,''),true);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.invalidate_synced_workspace() from public,anon,authenticated;
create trigger private_pages_invalidate_synced after insert or update or delete on public.private_pages
for each row execute function private.invalidate_synced_workspace();
create trigger pages_invalidate_synced after update of published,deleted_at on public.pages
for each row when(old.published is distinct from new.published or old.deleted_at is distinct from new.deleted_at)
execute function private.invalidate_synced_workspace();
create trigger pages_delete_invalidate_synced before delete on public.pages
for each row execute function private.invalidate_synced_workspace();

-- File references include content held outside the page JSON, plus archived pages and versions.
create function private.file_reference_pages(p_file text)
returns table(page_id text,workspace_id uuid) language sql stable security definer set search_path='' as $$
  select p.id,p.workspace_id from public.page_files pf join public.pages p on p.id=pf.page_id where pf.file_id=p_file
  union
  select s.source_page_id,s.workspace_id from private.workspace_synced_blocks s
  where jsonb_path_exists(s.blocks,'$.**.fileId ? (@ == $file)',jsonb_build_object('file',p_file));
$$;
revoke all on function private.file_reference_pages(text) from public,anon,authenticated;

-- Old created_by values were client supplied; do not trust them as staging ownership.
alter table public.files add column uploaded_by uuid references auth.users(id) on delete set null;
create function private.can_read_file(p_file text,p_ws uuid,p_uploaded_by uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.file_reference_pages(p_file) r join public.pages p on p.id=r.page_id
    where r.workspace_id=p_ws and p.data is not null and p.deleted_at is null
      and (p.published or private.can_read_page(p.id,p.workspace_id)))
  or (private.is_human_editor(p_ws)
    and not exists(select 1 from private.file_reference_pages(p_file))
    and coalesce(p_uploaded_by,(select f.uploaded_by from public.files f where f.id=p_file and f.workspace_id=p_ws))=auth.uid());
$$;
create function private.can_write_file(p_file text,p_ws uuid,p_delete boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_human_editor(p_ws) and (
    case when exists(select 1 from private.file_reference_pages(p_file)) then
      not p_delete and not exists(select 1 from private.file_reference_pages(p_file) r
        where r.workspace_id<>p_ws or r.page_id is null or not private.can_write_page(r.page_id,r.workspace_id))
    else exists(select 1 from public.files f where f.id=p_file and f.workspace_id=p_ws and f.uploaded_by=auth.uid()) end);
$$;
revoke all on function private.can_read_file(text,uuid,uuid),private.can_write_file(text,uuid,boolean) from public;
grant execute on function private.can_read_file(text,uuid,uuid) to anon,authenticated;
grant execute on function private.can_write_file(text,uuid,boolean) to authenticated;

create function private.protect_file_identity()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then new.uploaded_by:=auth.uid();
  else
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id then
      raise exception using errcode='PT403',message='file_identity_immutable';
    end if;
    new.uploaded_by:=old.uploaded_by;
  end if;
  return new;
end $$;
revoke all on function private.protect_file_identity() from public,anon,authenticated;
create trigger files_protect_identity before insert or update on public.files for each row execute function private.protect_file_identity();

drop policy "anyone resolves file location" on public.files;
create policy "file readers resolve location" on public.files for select to anon,authenticated
-- Use the stamped row value: an upsert RETURNING check cannot re-query its new row yet.
using(private.can_read_file(id,workspace_id,uploaded_by));
create function private.can_register_file(p_file text,p_ws uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_human_editor(p_ws) and not exists(
    select 1 from private.file_reference_pages(p_file) r where r.workspace_id<>p_ws
      or r.page_id is null or not private.can_write_page(r.page_id,r.workspace_id));
$$;
revoke all on function private.can_register_file(text,uuid) from public;
grant execute on function private.can_register_file(text,uuid) to authenticated;
drop policy "editors register files" on public.files;
create policy "editors register files" on public.files for insert to authenticated
with check(private.can_register_file(id,workspace_id));
drop policy "editors update files" on public.files;
create policy "file writers update metadata" on public.files for update to authenticated
using(private.can_write_file(id,workspace_id)) with check(private.can_write_file(id,workspace_id));
drop policy "editors delete files" on public.files;
create policy "uploaders delete unused metadata" on public.files for delete to authenticated
using(private.can_write_file(id,workspace_id,true));

-- Path lookup joins the registry instead of casting attacker-controlled path segments to uuid.
create function private.can_access_file_object(p_name text,p_write boolean default false,p_delete boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.files f where f.id=split_part(p_name,'/',2)
    and f.workspace_id::text=split_part(p_name,'/',1)
    and case when p_write then private.can_write_file(f.id,f.workspace_id,p_delete)
      else private.can_read_file(f.id,f.workspace_id) end);
$$;
revoke all on function private.can_access_file_object(text,boolean,boolean) from public;
grant execute on function private.can_access_file_object(text,boolean,boolean) to anon,authenticated;
drop policy "members read files" on storage.objects;
drop policy "page readers read files" on storage.objects;
create policy "page readers read files" on storage.objects for select to anon,authenticated
using(bucket_id='files' and private.can_access_file_object(name));
drop policy "editors upload files" on storage.objects;
create policy "file writers upload" on storage.objects for insert to authenticated
with check(bucket_id='files' and private.can_access_file_object(name,true));
drop policy "editors update files" on storage.objects;
create policy "file writers update" on storage.objects for update to authenticated
using(bucket_id='files' and private.can_access_file_object(name,true))
with check(bucket_id='files' and private.can_access_file_object(name,true));
drop policy "editors delete files" on storage.objects;
create policy "uploaders delete unused objects" on storage.objects for delete to authenticated
using(bucket_id='files' and private.can_access_file_object(name,true,true));

-- A guessed file id must not create a new readable association to a hidden file.
create function private.check_file_references(p_data jsonb,p_ws uuid,p_existing_page text default null)
returns void language plpgsql security definer set search_path='' as $$
declare f text; ws uuid;
begin
  if auth.uid() is null then return; end if;
  for f in select distinct value#>>'{}' from jsonb_path_query(p_data,'$.**.fileId') value
    where jsonb_typeof(value)='string' and length(value#>>'{}')>0 loop
    if p_existing_page is not null and exists(select 1 from public.page_files pf where pf.page_id=p_existing_page and pf.file_id=f) then continue; end if;
    select workspace_id into ws from public.files where id=f;
    -- Restoring a reference may precede restoring its archived source page. Writers can
    -- reuse that file; the separate read policy still keeps archived bytes inaccessible.
    if found and (ws<>p_ws or not (private.can_read_file(f,ws) or private.can_write_file(f,ws))) then
      raise exception using errcode='PT403',message='forbidden_file_reference';
    end if;
    if ws is null and exists(select 1 from private.file_reference_pages(f) r
      where r.workspace_id<>p_ws or not private.can_read_page(r.page_id,r.workspace_id)) then
      raise exception using errcode='PT403',message='forbidden_file_reference';
    end if;
  end loop;
end $$;
revoke all on function private.check_file_references(jsonb,uuid,text) from public,anon,authenticated;
create or replace function private.maintain_page_files()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.check_file_references(new.data,new.workspace_id,new.id);
  delete from public.page_files where page_id=new.id;
  if new.data is not null then
    insert into public.page_files(page_id,file_id)
    select distinct new.id,value#>>'{}' from jsonb_path_query(new.data,'$.**.fileId') value
    where jsonb_typeof(value)='string' and length(value#>>'{}')>0 on conflict do nothing;
  end if;
  return new;
end $$;

create or replace function public.apply_workspace_ops(p_workspace_id uuid,p_ops jsonb,p_client text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.workspaces%rowtype; op jsonb; rev bigint; source text; sources int;
begin
  if not private.is_human_editor(p_workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops)>200 then
    raise exception using errcode='PT400',message='invalid_operations'; end if;
  select * into w from public.workspaces where id=p_workspace_id for update;
  for op in select value from jsonb_array_elements(p_ops) loop
    case op->>'op'
      when 'set_root_order' then w.root_order:=op->'rootOrder';
      when 'set_settings' then w.settings:=w.settings||op->'patch';
      when 'synced_set' then
        if nullif(op->>'key','') is null or not (op ? 'blocks') or (op->'blocks'<>'null'::jsonb and jsonb_typeof(op->'blocks') is distinct from 'array') then
          raise exception using errcode='PT400',message='invalid_operations'; end if;
        select source_page_id into source from private.workspace_synced_blocks where workspace_id=p_workspace_id and key=op->>'key';
        if not found then
          select min(p.id),count(distinct p.id) into source,sources
          from public.pages p,lateral private.all_blocks(p.data) b
          where p.workspace_id=p_workspace_id and p.deleted_at is null and b->>'type'='synced'
            and b->>'id'=op->>'key' and nullif(b->>'syncedFrom','') is null;
          if sources<>1 then source:=null; end if;
        end if;
        if source is null or not private.can_write_page(source,p_workspace_id) then
          raise exception using errcode='PT403',message='forbidden_synced_source'; end if;
        if op->'blocks'='null'::jsonb then
          delete from private.workspace_synced_blocks where workspace_id=p_workspace_id and key=op->>'key';
        else
          perform private.check_file_references(op->'blocks',p_workspace_id);
          insert into private.workspace_synced_blocks(workspace_id,key,source_page_id,blocks)
          values(p_workspace_id,op->>'key',source,op->'blocks')
          on conflict(workspace_id,key) do update set blocks=excluded.blocks;
        end if;
      else raise exception using errcode='PT400',message='unknown_operation';
    end case;
  end loop;
  perform set_config('app.ops_write','1',true);
  perform set_config('app.synced_write','1',true);
  update public.workspaces set root_order=w.root_order,settings=w.settings where id=p_workspace_id returning revision into rev;
  perform set_config('app.ops_write','',true);
  perform set_config('app.synced_write','',true);
  return jsonb_build_object('revision',rev,'client',p_client);
end $$;

-- Decisions carry task content and use the same visibility as the task, including its delegate.
alter policy "members or run owner read approvals" on public.agent_approvals
using(private.can_read_task(task_id) or private.is_own_run(run_id));
alter policy "members or run owner read external ops" on public.external_ops
using(private.can_read_task(task_id) or private.is_own_run(run_id));
