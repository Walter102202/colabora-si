-- 0017_platform_agent: one managed Lead agent per workspace, "Colabora", enabled by the workspace owner (workspaces.owner_id)
-- from Settings > Agents. It gets no page grants here: grants arrive when tasks are delegated (ensure_delegate_grants).

alter table public.agents add column is_platform boolean not null default false;
-- One live platform agent per workspace; a revoked one may be replaced.
create unique index agents_platform_per_workspace_uidx on public.agents (workspace_id) where is_platform and revoked_at is null;

-- service_role only (agent-admin creates the auth user and calls this). Idempotent: returns the live platform agent.
create or replace function public.ensure_platform_agent(p_workspace_id uuid, p_created_by uuid, p_auth_user_id uuid, p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_a public.agents%rowtype; v_id uuid;
begin
  select owner_id into v_owner from public.workspaces where id = p_workspace_id;
  if v_owner is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  -- Only the workspace owner (workspaces.owner_id) enables it: the row is sponsored by v_owner, so nobody else may create it.
  if p_created_by <> v_owner then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  select * into v_a from public.agents where workspace_id = p_workspace_id and is_platform and revoked_at is null;
  if found then
    return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id, 'created', false);
  end if;
  if p_auth_user_id is null then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'auth_user_id is required'; end if;
  begin
    insert into public.agents (id, workspace_id, auth_user_id, name, kind, delivery, role, sponsor_user_id, monthly_budget_usd,
                               capabilities, connection, created_by, is_platform)
    values (coalesce(p_id, gen_random_uuid()), p_workspace_id, p_auth_user_id, 'Colabora', 'managed', 'pull', 'lead', v_owner, 20,
            '{"start":true,"continue":true,"cancel":true,"approval":true,"cost":true}'::jsonb,
            '{"harness":"agent","model":"muse-spark-1.3","platform":true}'::jsonb, p_created_by, true)
    returning id into v_id;
  exception when unique_violation then
    -- The owner pressed the button twice at once: the other insert won. Any other unique violation (auth_user_id, 0002:10) is re-raised.
    select * into v_a from public.agents where workspace_id = p_workspace_id and is_platform and revoked_at is null;
    if v_a.id is null then raise; end if;
    return jsonb_build_object('agent_id', v_a.id, 'auth_user_id', v_a.auth_user_id, 'created', false);
  end;
  perform private.audit(p_workspace_id, 'agent.create', jsonb_build_object('agent_id', v_id, 'created_by', p_created_by, 'platform', true));
  return jsonb_build_object('agent_id', v_id, 'auth_user_id', p_auth_user_id, 'created', true);
end $$;
-- Same grant pattern as create_agent (0002:247): nothing for public, anon or authenticated; service_role keeps execute.
revoke all on function public.ensure_platform_agent(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Prices so cost_usd exists on a hosted database that never ran the seed. Change a price with a later `update`.
insert into public.model_prices (model, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok, effective_from, source) values
  ('muse-spark-1.3',                   1.25, 4.25, null, date '2026-10-26', 'provider list price'),
  ('muse-spark-open-1026',             0.60, 2.40, null, date '2026-10-26', 'estimate for hosted open weights'),
  ('meta-models/muse-spark-open-1026', 0.60, 2.40, null, date '2026-10-26', 'Baseten model id; same price as muse-spark-open-1026')
on conflict (model) do nothing;
