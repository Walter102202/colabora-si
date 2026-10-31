-- 0032_task_environment: the environment of a task has an owner. A Lead or a person reserves ports, a stack, a worktree, a
-- branch and migration numbers for a task, no two open tasks can hold the same one, and when the task ends the Lead is
-- told what to stop. The database cannot stop a process: a held resource stays visible until someone confirms it.

create table public.agent_resources (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id      uuid not null references public.agent_tasks(id) on delete cascade,
  kind         text not null check (kind in ('ports','stack','worktree','branch','migration')),
  value        text not null check (char_length(value) between 1 and 300),
  port_low     int,
  port_high    int,
  status       text not null default 'held' check (status in ('held','releasing','released')),
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  release_requested_at timestamptz,
  released_at  timestamptz,
  check ((kind = 'ports') = (port_low is not null and port_high is not null)),
  check (port_low is null or (port_low between 1 and 65535 and port_high between port_low and 65535))
);
create unique index agent_resources_open_uidx on public.agent_resources (workspace_id, kind, value) where status <> 'released';
create index agent_resources_task_idx on public.agent_resources (task_id);

alter table public.agent_resources enable row level security;
-- No write policy: state changes only through the RPCs below and the trigger.
create policy agent_resources_select on public.agent_resources for select
  using (exists (select 1 from public.agent_tasks t where t.id = task_id));
grant select on public.agent_resources to authenticated;

-- A Lead on its own task or on a subtask of it, or a person who can edit the row.
create or replace function private.can_manage_environment(p_t public.agent_tasks)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_agent uuid;
begin
  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    if not exists(select 1 from public.agents a where a.id=v_agent and a.role='lead') then return false; end if;
    if exists(select 1 from public.agent_tasks p where p.id=p_t.parent_task_id and p.delegate_agent_id=v_agent) then
      perform private.require_active_task(p_t.parent_task_id);
    elsif p_t.delegate_agent_id=v_agent then
      perform private.require_active_task(p_t.id);
    else return false;
    end if;
    return true;
  end if;
  return private.can_write_page(p_t.row_page_id, p_t.workspace_id);
end $$;
revoke execute on function private.can_manage_environment(public.agent_tasks) from public;

-- Resource identity follows Windows worktree/branch spelling rules; display and audit use the canonical value.
create or replace function private.environment_key(p_kind text,p_value text)
returns text language sql immutable set search_path = '' as $$
  select case when p_kind in ('worktree','branch') then lower(rtrim(regexp_replace(replace(btrim(p_value),E'\\','/'),'/+','/','g'),'/')) else btrim(p_value) end;
$$;
revoke all on function private.environment_key(text,text) from public;

create or replace function public.reserve_environment(p_task_id uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_item jsonb; v_kind text; v_value text; v_m text[]; v_low int; v_high int;
        v_hold public.agent_resources%rowtype; v_audit_items jsonb:='[]';
begin
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.can_manage_environment(v_t) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if private.is_agent() then perform private.check_rate(private.current_agent_id()); end if;
  if v_t.state in ('done','failed','cancelled') then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  -- One reservation at a time per workspace: the overlap of port ranges cannot be a unique index.
  perform pg_advisory_xact_lock(hashtextextended('agent_resources:' || v_t.workspace_id::text, 0));
  for v_item in select e from jsonb_array_elements(p_items) e loop
    v_kind := v_item->>'kind';
    v_value := private.environment_key(v_kind,coalesce(v_item->>'value',''));
    if v_kind is null or v_kind not in ('ports','stack','worktree','branch','migration') or v_value = '' or char_length(v_value) > 300 then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'each item has a kind and a value';
    end if;
    -- Credentials are never environment identifiers. Reject common credential forms before storage or audit.
    if v_value ~* '(://[^/?#[:space:]]*@|[?&;[:space:]]?(password|passwd|token|secret|api[_-]?key|authorization)[[:space:]]*[:=]|bearer[[:space:]]|-----begin.*private key|(^|[^a-z0-9])(agt_|sb_secret_|sk_live_)[a-z0-9_-]+|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.)'
       or (v_kind='stack' and v_value !~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') then
      raise exception using errcode='PT400',message='invalid_input',detail='environment values are identifiers, never credentials';
    end if;
    v_low := null; v_high := null;
    if v_kind = 'ports' then
      v_m := regexp_match(v_value, '^([0-9]{1,5})-([0-9]{1,5})$');
      if v_m is null or v_m[1]::int not between 1 and 65535 or v_m[2]::int not between v_m[1]::int and 65535 then
        raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'ports look like 60940-60949';
      end if;
      v_low := v_m[1]::int; v_high := v_m[2]::int; v_value := v_low || '-' || v_high;
      select * into v_hold from public.agent_resources r
       where r.workspace_id = v_t.workspace_id and r.kind = 'ports' and r.status <> 'released' and r.task_id <> v_t.id
         and int4range(r.port_low, r.port_high, '[]') && int4range(v_low, v_high, '[]') limit 1;
    elsif v_kind = 'migration' and v_value !~ '^[0-9]{4}$' then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'a migration number has four digits';
    else
      select * into v_hold from public.agent_resources r
       where r.workspace_id = v_t.workspace_id and r.kind = v_kind and private.environment_key(r.kind,r.value) = v_value and r.status <> 'released' and r.task_id <> v_t.id limit 1;
    end if;
    if v_hold.id is not null then
      raise exception using errcode = 'PT409', message = 'resource_taken',
        detail = jsonb_build_object('kind', v_hold.kind, 'value', v_hold.value, 'task_id', v_hold.task_id, 'status', v_hold.status)::text;
    end if;
    insert into public.agent_resources (workspace_id, task_id, kind, value, port_low, port_high, created_by)
    select v_t.workspace_id, v_t.id, v_kind, v_value, v_low, v_high, (select auth.uid())
     where not exists (select 1 from public.agent_resources r
                        where r.task_id = v_t.id and r.kind = v_kind and private.environment_key(r.kind,r.value) = v_value and r.status <> 'released');
    v_audit_items:=v_audit_items || jsonb_build_array(jsonb_build_object('kind',v_kind,'value',v_value));
  end loop;
  perform private.audit(v_t.workspace_id, 'environment.reserve', jsonb_build_object('task_id', v_t.id, 'items', v_audit_items));
  return (select coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'value', r.value, 'status', r.status) order by r.created_at), '[]'::jsonb)
            from public.agent_resources r where r.task_id = v_t.id and r.status <> 'released');
end $$;
revoke all on function public.reserve_environment(uuid, jsonb) from public, anon;
grant execute on function public.reserve_environment(uuid, jsonb) to authenticated;

create or replace function public.release_environment(p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_count int;
begin
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.can_manage_environment(v_t) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if private.is_agent() then perform private.check_rate(private.current_agent_id()); end if;
  update public.agent_resources set status = 'released', released_at = now() where task_id = v_t.id and status <> 'released';
  get diagnostics v_count = row_count;
  perform private.audit(v_t.workspace_id, 'environment.release', jsonb_build_object('task_id', v_t.id, 'count', v_count));
  return jsonb_build_object('released', v_count);
end $$;
revoke all on function public.release_environment(uuid) from public, anon;
grant execute on function public.release_environment(uuid) to authenticated;

-- A task that ends gives its migration numbers back at once and asks the Lead to stop the rest.
create or replace function private.task_environment_ended()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_lead uuid; v_target uuid; v_items jsonb;
begin
  update public.agent_resources set status = 'released', released_at = now()
   where task_id = new.id and kind = 'migration' and status = 'held';
  with changed as (
    update public.agent_resources set status = 'releasing', release_requested_at = now()
     where task_id = new.id and status = 'held'
    returning kind, value
  )
  select jsonb_agg(jsonb_build_object('kind', kind, 'value', value)) into v_items from changed;
  if v_items is null then return null; end if;
  select p.delegate_agent_id,p.id into v_lead,v_target from public.agent_tasks p join public.agents a on a.id = p.delegate_agent_id
   where p.id = new.parent_task_id and a.role = 'lead';
  if v_lead is null then
    select a.id,new.id into v_lead,v_target from public.agents a where a.id=new.delegate_agent_id and a.role='lead';
  end if;
  if v_lead is not null then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (new.workspace_id, v_target, null, v_lead, 'task.updated',
      jsonb_build_object('subtask_id', new.id, 'subtask_state', new.state, 'environment_release', v_items),
      private.next_event_seq(v_target));
  else
    insert into public.notifications(workspace_id,user_id,kind,page_id,task_id,actor_type,payload)
    values(new.workspace_id,new.owner_user_id,'input_required',new.row_page_id,new.id,'system',
      jsonb_build_object('subtask_id',new.id,'environment_release',v_items));
  end if;
  return null;
end $$;
revoke execute on function private.task_environment_ended() from public;

create trigger agent_tasks_environment_ended after update of state on public.agent_tasks
  for each row when (new.state in ('done','failed','cancelled') and old.state not in ('done','failed','cancelled'))
  execute function private.task_environment_ended();
