-- Agents added in Settings have no connection row and can take jobs. A connection still pending stays refused.
create or replace function private.grant_job_agents(p_database_id text, p_agent_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_db public.pages%rowtype; v_a public.agents%rowtype; v_id uuid; v_granted jsonb := '[]';
begin
  select * into v_db from public.pages where id=p_database_id and deleted_at is null;
  if not found or not private.can_write_page(v_db.id,v_db.workspace_id) then
    raise exception using errcode='PT403',message='owner_required';
  end if;
  for v_id in select distinct id from unnest(p_agent_ids) id order by id loop
    select * into v_a from public.agents a where a.id=v_id and a.workspace_id=v_db.workspace_id
      and a.status='enabled' and a.revoked_at is null and not a.is_platform
      and not exists(select 1 from public.agent_connections c where c.agent_id=a.id and c.verified_at is null) for update;
    if not found then raise exception using errcode='PT422',message='agent_not_available'; end if;
    if not exists (
      with recursive chain as (
        select p.id,p.parent_id,0 as depth from public.pages p where p.id=v_db.id
        union all select p.id,p.parent_id,c.depth+1 from chain c join public.pages p on p.id=c.parent_id where c.depth<2
      ) select 1 from public.agent_grants g join chain c on c.id=g.page_id
        where g.agent_id=v_id and g.inherit and g.revoked_at is null and (g.expires_at is null or g.expires_at>now())
          and g.scopes @> array['read','write','comment']
    ) then
      if not private.can_edit_workspace(v_db.workspace_id) then
        raise exception using errcode='PT403',message='owner_required',detail=v_a.name;
      end if;
      perform public.grant_agent_page(v_id,v_db.id,array['read','write','comment'],true);
      v_granted := v_granted || jsonb_build_array(jsonb_build_object('id',v_id,'name',v_a.name));
    end if;
  end loop;
  return v_granted;
end $$;
revoke all on function private.grant_job_agents(text,uuid[]) from public,anon,authenticated;
