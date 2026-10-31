-- 0035_conditional_approval: "merge if the last review approved and CI is green" as a rule the server checks. A person
-- writes policies.preapproved_if in the app; request_approval grants the action when every condition holds, and
-- begin_external_op checks them again at the moment of acting. If one fails the action asks a person, as it always did.

alter table public.agent_approvals drop constraint agent_approvals_auto_by_check;
alter table public.agent_approvals add constraint agent_approvals_auto_by_check check (auto_by in ('preset','brief','condition'));

-- Trust is an attestation for an individual action and its current value, not for a whole brief.
alter table public.task_briefs add column trusted_preapprovals jsonb not null default '{"preapproved":[],"preapproved_if":{}}';

create or replace function private.next_preapproval_trust(p_old jsonb, p_trust jsonb, p_new jsonb, p_owner_write boolean)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_action text; v_entry record; v_list jsonb := '[]'; v_rules jsonb := '{}';
begin
  for v_action in select jsonb_array_elements_text(case when jsonb_typeof(p_new->'preapproved')='array' then p_new->'preapproved' else '[]'::jsonb end) loop
    if ((coalesce(p_old->'preapproved','[]') ? v_action) and (coalesce(p_trust->'preapproved','[]') ? v_action))
       or (p_owner_write and not (coalesce(p_old->'preapproved','[]') ? v_action)) then
      v_list := v_list || to_jsonb(v_action);
    end if;
  end loop;
  for v_entry in select key,value from jsonb_each(case when jsonb_typeof(p_new->'preapproved_if')='object' then p_new->'preapproved_if' else '{}'::jsonb end) loop
    if (v_entry.value is not distinct from p_old->'preapproved_if'->v_entry.key
        and v_entry.value is not distinct from p_trust->'preapproved_if'->v_entry.key)
       or (p_owner_write and v_entry.value is distinct from p_old->'preapproved_if'->v_entry.key) then
      v_rules := v_rules || jsonb_build_object(v_entry.key,v_entry.value);
    end if;
  end loop;
  return jsonb_build_object('preapproved',v_list,'preapproved_if',v_rules);
end $$;
revoke all on function private.next_preapproval_trust(jsonb,jsonb,jsonb,boolean) from public;

-- Recover entry provenance from version history; a later human edit of a sibling cannot promote old agent entries.
do $$
declare v_b public.task_briefs%rowtype; v_old public.task_briefs%rowtype;
begin
  for v_b in select * from public.task_briefs order by task_id,version loop
    select * into v_old from public.task_briefs where task_id=v_b.task_id and version<v_b.version order by version desc limit 1;
    update public.task_briefs set trusted_preapprovals=private.next_preapproval_trust(coalesce(v_old.policies,'{}'),coalesce(v_old.trusted_preapprovals,'{}'),v_b.policies,
      v_b.author_type='human' and v_b.preapproved_trusted
        and exists(select 1 from public.agent_tasks t where t.id=v_b.task_id and t.owner_user_id=v_b.author_id)) where task_id=v_b.task_id and version=v_b.version;
  end loop;
end $$;

create or replace function private.track_preapproval_trust()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_old public.task_briefs%rowtype; v_changed boolean; v_owner boolean;
begin
  select * into v_old from public.task_briefs where task_id=new.task_id and version<new.version order by version desc limit 1;
  v_changed := coalesce(new.policies->'preapproved','[]') is distinct from coalesce(v_old.policies->'preapproved','[]')
    or coalesce(new.policies->'preapproved_if','{}') is distinct from coalesce(v_old.policies->'preapproved_if','{}');
  v_owner := private.principal_type()='human' and private.jwt_client_id() is null and private.is_workspace_owner(new.workspace_id);
  if v_changed and not v_owner then
    if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
    raise exception using errcode='PT403',message='owner_required';
  end if;
  new.trusted_preapprovals := private.next_preapproval_trust(coalesce(v_old.policies,'{}'),coalesce(v_old.trusted_preapprovals,'{}'),new.policies,v_owner);
  return new;
end $$;
revoke all on function private.track_preapproval_trust() from public;
create trigger task_briefs_preapproval_trust before insert on public.task_briefs for each row execute function private.track_preapproval_trust();

create or replace function private.policy_action_trusted(p_b public.task_briefs,p_action text,p_conditional boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when p_conditional then
    jsonb_typeof(p_b.policies->'preapproved_if'->p_action)='array'
    and p_b.trusted_preapprovals->'preapproved_if'->p_action = p_b.policies->'preapproved_if'->p_action
  else coalesce(p_b.trusted_preapprovals->'preapproved','[]') ? p_action
    and coalesce(p_b.policies->'preapproved','[]') ? p_action end is true;
$$;
revoke all on function private.policy_action_trusted(public.task_briefs,text,boolean) from public;

create or replace function private.merge_rule_state(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_b public.task_briefs%rowtype; v_up uuid:=p_task_id; v_depth int:=0; v_required text[]; v_enabled boolean;
begin
  select b.* into v_b from public.task_briefs b join public.agent_tasks t on t.id=b.task_id and t.brief_version=b.version where t.id=p_task_id;
  v_enabled := private.policy_action_trusted(v_b,'git.merge',true)
    and v_b.policies->'preapproved_if'->'git.merge' @> '["review_approved","ci_green"]'::jsonb;
  while v_up is not null and v_depth<10 loop
    select private.required_actions(b.policies),t.parent_task_id into v_required,v_up from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version where t.id=v_up;
    if v_required is null or 'git.merge'=any(v_required) then v_enabled:=false; end if;
    v_depth:=v_depth+1;
  end loop;
  if v_up is not null then v_enabled:=false; end if;
  return jsonb_build_object('enabled',coalesce(v_enabled,false));
end $$;
revoke all on function private.merge_rule_state(uuid) from public;

create or replace function public.set_merge_rule(p_task_id uuid,p_conditions text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_rules jsonb; v_version int;
begin
  select * into v_t from public.agent_tasks where id=p_task_id for update;
  if not found then raise exception using errcode='PT404',message='not_found'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  if private.principal_type()<>'human' or not private.is_workspace_owner(v_t.workspace_id) then raise exception using errcode='PT403',message='owner_required'; end if;
  if p_conditions is not null and (cardinality(p_conditions)<>2 or not p_conditions @> array['review_approved','ci_green']) then
    raise exception using errcode='PT400',message='invalid_input';
  end if;
  select * into v_b from public.task_briefs where task_id=v_t.id and version=v_t.brief_version;
  v_rules := coalesce(v_b.policies->'preapproved_if','{}') - 'git.merge';
  if p_conditions is not null then v_rules:=v_rules || '{"git.merge":["review_approved","ci_green"]}'::jsonb; end if;
  v_version:=public.update_brief(v_t.id,jsonb_build_object('policies',v_b.policies || jsonb_build_object('preapproved_if',v_rules)));
  -- This narrow human action explicitly attests git.merge even when legacy untrusted JSON had the same value.
  update public.task_briefs set trusted_preapprovals=jsonb_set(trusted_preapprovals,'{preapproved_if}',
    (coalesce(trusted_preapprovals->'preapproved_if','{}')-'git.merge') || case when p_conditions is null then '{}'::jsonb else '{"git.merge":["review_approved","ci_green"]}'::jsonb end)
   where task_id=v_t.id and version=v_version;
  perform private.audit(v_t.workspace_id,'task.merge_rule_set',jsonb_build_object('task_id',v_t.id,'enabled',p_conditions is not null));
  return public.task_autonomy(v_t.id);
end $$;
revoke all on function public.set_merge_rule(uuid,text[]) from public,anon;
grant execute on function public.set_merge_rule(uuid,text[]) to authenticated;

-- p_params.subtask_id names the delivery a Lead acts on, from its run on the parent; without it, the run's own task.
create or replace function private.conditional_allowed(p_action text, p_run public.agent_runs, p_params jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_subject public.agent_tasks%rowtype;
        v_art public.agent_artifacts%rowtype; v_review public.agent_reviews%rowtype;
        v_conds jsonb; v_required text[]; v_up uuid; v_depth int:=0; v_repo text; v_sha text; v_c jsonb; v_ci jsonb;
begin
  if coalesce(p_action,'')='' or p_action='payment' or p_run.status not in ('running','waiting') or p_run.stop_requested_at is not null then return false; end if;
  select * into v_t from public.agent_tasks where id=p_run.task_id and active_run_id=p_run.id;
  if not found then return false; end if;
  select * into v_b from public.task_briefs where task_id=v_t.id and version=v_t.brief_version;
  if not private.policy_action_trusted(v_b,p_action,true) then return false; end if;
  v_conds:=v_b.policies->'preapproved_if'->p_action;
  if jsonb_typeof(v_conds) is distinct from 'array' or jsonb_array_length(v_conds)=0
     or exists(select 1 from jsonb_array_elements_text(v_conds) c where c not in ('review_approved','ci_green')) then return false; end if;
  v_subject:=v_t;
  if coalesce(p_params->>'subtask_id','')<>'' then
    if p_params->>'subtask_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return false; end if;
    select * into v_subject from public.agent_tasks where id=(p_params->>'subtask_id')::uuid and parent_task_id=v_t.id;
    if not found then return false; end if;
  end if;
  if not (v_subject.state='ready_for_review' or (v_subject.state='done' and v_subject.acceptance='accepted')) then return false; end if;
  -- Start with the subject, so its own veto and every ancestor's veto apply.
  v_up:=v_subject.id;
  while v_up is not null and v_depth<10 loop
    select private.required_actions(b.policies),t.parent_task_id into v_required,v_up
      from public.agent_tasks t join public.task_briefs b on b.task_id=t.id and b.version=t.brief_version where t.id=v_up;
    if not found or v_required is null or p_action=any(v_required) then return false; end if;
    v_depth:=v_depth+1;
  end loop;
  if v_up is not null then return false; end if;
  select * into v_art from public.agent_artifacts where task_id=v_subject.id and superseded_by is null order by created_at desc,id desc limit 1;
  if not found then return false; end if;
  -- CI and approval are one proof, even if a rule lists just one of them.
  select * into v_review from public.agent_reviews where task_id=v_subject.id order by created_at desc,id desc limit 1;
  if not found or v_review.verdict<>'approved' or not v_review.direct_session or v_review.outdated_by is not null
     or v_review.brief_version<>v_subject.brief_version or v_review.artifact_id<>v_art.id or v_review.artifact_version<>v_art.version
     or exists(select 1 from public.agent_artifacts a where a.task_id=v_subject.id and a.ref=v_art.ref
       and a.author_type=v_review.reviewer_type and a.author_id=v_review.reviewer_id) then return false; end if;
  if exists(select 1 from public.agent_reviews r where r.task_id=v_subject.id and r.reviewer_type='human'
    and r.artifact_id=v_art.id and r.artifact_version=v_art.version and r.verdict<>'approved') then return false; end if;
  if v_art.kind='diff' then
    select repo,sha into v_repo,v_sha from private.ci_commit(v_art.ref);
    if v_sha is null or p_params->>'repo' is distinct from v_repo or p_params->>'head_sha' is distinct from v_sha then return false; end if;
  elsif v_art.kind='page' then
    if p_params->>'page_id' is distinct from v_art.ref
       or not exists(select 1 from public.pages p where p.id=v_art.ref and p.workspace_id=v_art.workspace_id and p.revision=v_art.page_revision and p.deleted_at is null) then return false; end if;
  else return false;
  end if;
  if v_conds ? 'ci_green' then
    if v_art.kind<>'diff' or not private.deterministic_checks_pass(v_subject.id) then return false; end if;
    select * into v_b from public.task_briefs where task_id=v_subject.id and version=v_subject.brief_version;
    if not exists(select 1 from jsonb_array_elements(v_b.done_when) c where c->>'check'='ci') then return false; end if;
    for v_c in select c from jsonb_array_elements(v_b.done_when) c where c->>'check'='ci' loop
      v_ci:=private.ci_criterion(v_subject,v_c);
      if v_ci->>'state' is distinct from 'passed' or v_ci->>'repo' is distinct from v_repo or v_ci->>'sha' is distinct from v_sha
         or not exists(select 1 from jsonb_array_elements(v_review.findings) f where f->>'criterion_id'=v_c->>'id' and f->>'status'='verified' and coalesce(f->>'severity','blocking')='blocking') then return false; end if;
    end loop;
  end if;
  return true;
end $$;
revoke execute on function private.conditional_allowed(text, public.agent_runs, jsonb) from public;

-- Full copy of validate_brief (0034); preapproved_if is checked here.
create or replace function private.validate_brief(p_brief jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_brief) is distinct from 'object' or coalesce(btrim(p_brief->>'objective'), '') = '' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'objective is required';
  end if;
  if p_brief ? 'done_when' then
    if jsonb_typeof(p_brief->'done_when') <> 'array' then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'done_when must be an array';
    end if;
    if exists (select 1 from jsonb_array_elements(p_brief->'done_when') c where coalesce(c->>'id', '') = '')
       or (select count(*) from jsonb_array_elements(p_brief->'done_when')) <>
          (select count(distinct c->>'id') from jsonb_array_elements(p_brief->'done_when') c) then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'done_when ids must be unique';
    end if;
    if exists (select 1 from jsonb_array_elements(p_brief->'done_when') c
                where c->>'check' = 'ci' and coalesce(btrim(c->>'command'), '') = '') then
      raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'a ci criterion names its GitHub check in command';
    end if;
  end if;
  if jsonb_typeof(p_brief->'policies') not in ('object', 'null') then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'policies must be an object';
  end if;
  if coalesce(p_brief->'policies'->>'reviewer_agent_id', '') <> ''
     and p_brief->'policies'->>'reviewer_agent_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'policies.reviewer_agent_id must be an agent id';
  end if;
  if p_brief->'policies' ? 'lease_minutes' and (jsonb_typeof(p_brief->'policies'->'lease_minutes') <> 'number'
     or (p_brief->'policies'->>'lease_minutes') !~ '^[0-9]{2,4}$' or (p_brief->'policies'->>'lease_minutes')::int not between 30 and 1440) then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'policies.lease_minutes is a whole number from 30 to 1440';
  end if;
  if p_brief->'policies'->'preapproved_if' ? 'payment' then
    raise exception using errcode='PT400',message='invalid_input',detail='payment always requires a person and cannot have conditional preapproval';
  end if;
  if p_brief->'policies' ? 'preapproved_if' and (jsonb_typeof(p_brief->'policies'->'preapproved_if') <> 'object' or exists (
       select 1 from jsonb_each(p_brief->'policies'->'preapproved_if') e
        where jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) = 0
           or exists (select 1 from jsonb_array_elements(e.value) c where c #>> '{}' not in ('review_approved','ci_green')))) then
    raise exception using errcode = 'PT400', message = 'invalid_input',
      detail = 'policies.preapproved_if maps an action to a list of review_approved and ci_green';
  end if;
  if private.required_actions(p_brief->'policies') is null then
    raise exception using errcode = 'PT400', message = 'invalid_input',
      detail = 'policies.require_approval must be an action, a list of actions or an object keyed by action';
  end if;
end $$;

-- Full copy of update_brief (0020); a change to preapproved_if loses trust like a change to preapproved.
create or replace function public.update_brief(p_task_id uuid, p_patch jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_agent uuid; v_full boolean := false;
        v_author uuid; v_author_type text; v_bad text; v_new jsonb; v_ver int; v_d public.agents%rowtype; v_trusted boolean; v_spent numeric; v_deps uuid[]; v_reassign boolean;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    if v_t.state in ('done','failed','cancelled') then raise exception using errcode='PT422',message='invalid_state'; end if;
    if exists (select 1 from public.agent_tasks p join public.agents a on a.id = p.delegate_agent_id
                where p.id = v_t.parent_task_id and p.delegate_agent_id = v_agent and a.role = 'lead')
       and not (v_t.delegate_agent_id=v_agent and exists(select 1 from public.agent_runs r where r.id=v_t.active_run_id
         and r.agent_id=v_agent and r.status in ('running','waiting') and r.stop_requested_at is null)) then
      perform private.require_active_task(v_t.parent_task_id);
      v_full := true;
    elsif v_t.delegate_agent_id = v_agent then
      perform private.require_active_task(v_t.id);
      v_full := false;
    else
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_author := v_agent; v_author_type := 'agent';
  else
    if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then
      raise exception using errcode = 'PT403', message = 'forbidden';
    end if;
    v_full := true; v_author := (select auth.uid()); v_author_type := 'human';
  end if;

  select key into v_bad from jsonb_object_keys(p_patch) key
   where not key = any (case when v_full
                     then array['objective','constraints','done_when','decisions','sources','open_questions','next_step','policies',
                                'delegate_agent_id','depends_on_task_ids']
                     else array['decisions','open_questions','next_step'] end) limit 1;
  if v_bad is not null then raise exception using errcode = 'PT422', message = 'field_not_allowed', detail = v_bad; end if;

  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  -- A chat session acts for a person but never unlocks an action: what the brief allows or asks for is set from the app.
  if v_author_type = 'human' and private.jwt_client_id() is not null and p_patch ? 'policies'
     and (p_patch -> 'policies') is distinct from v_b.policies then
    raise exception using errcode = 'PT403', message = 'direct_session_required';
  end if;
  v_new := (to_jsonb(v_b) - 'task_id' - 'version' - 'workspace_id' - 'author_id' - 'author_type' - 'created_at' - 'preapproved_trusted' - 'trusted_preapprovals')
           || (p_patch - 'delegate_agent_id' - 'depends_on_task_ids');
  if p_patch ? 'policies' then
    if jsonb_typeof(p_patch->'policies') is distinct from 'object' then raise exception using errcode='PT400',message='invalid_input'; end if;
    v_new:=jsonb_set(v_new,'{policies}',v_b.policies || (p_patch->'policies'));
  end if;
  perform private.validate_brief(v_new);
  if v_author_type='agent' and not private.required_actions(v_b.policies) <@ private.required_actions(v_new->'policies') then
    raise exception using errcode='PT403',message='approval_policy_locked';
  end if;
  if v_author_type = 'agent' and exists (
    select 1 from jsonb_array_elements(v_b.done_when) old_criterion
     where old_criterion->>'check' = 'ci' and not exists (
       select 1 from jsonb_array_elements(v_new->'done_when') new_criterion
        where new_criterion->>'id' = old_criterion->>'id'
          and new_criterion->>'check' = 'ci'
          and new_criterion->>'command' is not distinct from old_criterion->>'command')) then
    raise exception using errcode = 'PT403', message = 'ci_criteria_locked';
  end if;

  if p_patch ? 'delegate_agent_id' and (p_patch->>'delegate_agent_id') is not null then
    select * into v_d from public.agents
     where id = (p_patch->>'delegate_agent_id')::uuid and workspace_id = v_t.workspace_id and status = 'enabled' and revoked_at is null;
    if not found then raise exception using errcode = 'PT404', message = 'delegate_not_found'; end if;
    if v_d.monthly_budget_usd is not null then
      select coalesce(sum(cost_usd),0) into v_spent from public.agent_runs where agent_id=v_d.id and started_at>=date_trunc('month',now());
      if v_spent>v_d.monthly_budget_usd then raise exception using errcode='PT402',message='budget_exceeded',
        detail=jsonb_build_object('spent_usd',v_spent,'budget_usd',v_d.monthly_budget_usd)::text; end if;
    end if;
  end if;
  if p_patch ? 'depends_on_task_ids' then
    if jsonb_typeof(p_patch->'depends_on_task_ids') is distinct from 'array' or exists(select 1 from jsonb_array_elements_text(p_patch->'depends_on_task_ids') d
      where d !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
      raise exception using errcode='PT422',message='invalid_dependency';
    end if;
    v_deps:=array(select d::uuid from jsonb_array_elements_text(p_patch->'depends_on_task_ids') d);
    -- Serialize context graph edits; otherwise concurrent A→B and B→A can both pass their snapshots.
    perform pg_advisory_xact_lock(hashtextextended('task_dependencies:'||v_t.context_id::text,0));
    if exists(select 1 from unnest(v_deps) d where not exists(select 1 from public.agent_tasks x where x.id=d and x.context_id=v_t.context_id and x.id<>v_t.id))
       or exists(with recursive reachable(id) as (
          select unnest(v_deps) union select unnest(t.depends_on_task_ids) from public.agent_tasks t join reachable r on r.id=t.id where t.context_id=v_t.context_id
        ) select 1 from reachable where id=v_t.id) then
      raise exception using errcode='PT422',message='invalid_dependency';
    end if;
  end if;
  v_reassign:=p_patch ? 'delegate_agent_id' and (p_patch->>'delegate_agent_id')::uuid is distinct from v_t.delegate_agent_id and v_t.active_run_id is not null;
  if v_reassign and v_t.state not in ('queued','working','input_required') then raise exception using errcode='PT409',message='run_active'; end if;

  v_ver := v_t.brief_version + 1;
  -- The preapproved list keeps its trust while it does not change; a new list is trusted only when a person writes it
  -- from the app itself.
  v_trusted := case
    when (coalesce(v_new->'policies', '{}'::jsonb) -> 'preapproved') is not distinct from (v_b.policies -> 'preapproved')
     and (coalesce(v_new->'policies', '{}'::jsonb) -> 'preapproved_if') is not distinct from (v_b.policies -> 'preapproved_if')
      then v_b.preapproved_trusted
    else v_author_type = 'human' and private.jwt_client_id() is null end;
  insert into public.task_briefs (task_id, version, workspace_id, objective, constraints, done_when, decisions, sources,
                                  open_questions, next_step, policies, author_id, author_type, preapproved_trusted)
  values (v_t.id, v_ver, v_t.workspace_id, v_new->>'objective', coalesce(v_new->>'constraints', ''),
          coalesce(v_new->'done_when', '[]'), coalesce(v_new->'decisions', '[]'), coalesce(v_new->'sources', '[]'),
          coalesce(v_new->'open_questions', '[]'), coalesce(v_new->>'next_step', ''), coalesce(v_new->'policies', '{}'),
          v_author, v_author_type, v_trusted);

  update public.agent_tasks
     set brief_version = v_ver,
         delegate_agent_id = case when p_patch ? 'delegate_agent_id' then (p_patch->>'delegate_agent_id')::uuid else delegate_agent_id end,
         depends_on_task_ids = case when p_patch ? 'depends_on_task_ids'
                                    then array(select d::uuid from jsonb_array_elements_text(p_patch->'depends_on_task_ids') d)
                                    else depends_on_task_ids end,
         updated_at = now()
   where id = v_t.id;

  -- A withdrawn brief authorization cannot leave reusable unconsumed automatic receipts behind.
  update public.agent_approvals a set status='cancelled'
    where a.task_id=v_t.id and a.status='decided' and a.auto_by='brief'
      and private.action_allowed(a.action,v_t.id) is distinct from 'brief';

  if v_reassign then
    perform private.release_for_handover(v_t.id,(p_patch->>'delegate_agent_id')::uuid,'Reassigned from the task brief.',p_patch->>'delegate_agent_id' is null);
  end if;
  if p_patch ? 'delegate_agent_id' and v_d.id is not null then
    perform private.ensure_delegate_grants(v_d.id, v_t.workspace_id, v_t.row_page_id, v_new->'sources');
  end if;
  perform private.audit(v_t.workspace_id, 'brief.update', jsonb_build_object('task_id', v_t.id, 'version', v_ver));
  return v_ver;
end $$;

-- Full copy of record_auto_approval (0020); only the summary text for a condition is new.
create or replace function private.record_auto_approval(p_run public.agent_runs, p_action text, p_params jsonb,
  p_artifact_id uuid, p_by text, p_consumed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_ver int; v_hash text; v_a public.agent_approvals%rowtype; v_level text;
begin
  select * into v_t from public.agent_tasks where id = p_run.task_id for update;
  if p_artifact_id is not null then
    select version into v_ver from public.agent_artifacts where id = p_artifact_id and task_id = v_t.id;
    if not found then raise exception using errcode = 'PT404', message = 'artifact_not_found'; end if;
  end if;
  v_hash := private.action_hash(p_action, v_t.id, v_ver, p_params);
  v_level := private.task_autonomy_level(v_t.id);
  update public.agent_approvals set status = 'cancelled'
   where task_id = v_t.id and kind = 'action' and status = 'pending' and action_hash = v_hash;
  if found and not private.task_waits_on_human(v_t.id) then
    update public.agent_runs set status = 'running' where id = p_run.id and status = 'waiting';
    update public.agent_tasks set state = 'working', waiting_on = null, updated_at = now()
     where id = v_t.id and state = 'input_required' and active_run_id = p_run.id;
  end if;
  if not p_consumed then
    select * into v_a from public.agent_approvals
     where task_id = v_t.id and auto_by = p_by and status = 'decided' and action_hash = v_hash and receipt_expires_at > now()
     order by decided_at desc limit 1;
    if found then
      return jsonb_build_object('approval_id', v_a.id, 'action_hash', v_hash, 'status', 'approved', 'receipt', v_a.receipt,
                                'receipt_expires_at', v_a.receipt_expires_at,
                                'auto_approved', jsonb_build_object('by', v_a.auto_by, 'level', v_level));
    end if;
  end if;
  insert into public.agent_approvals (workspace_id, task_id, run_id, kind, action, action_hash, params, artifact_id, artifact_version,
                                      question, options, status, decision, response, receipt, receipt_expires_at,
                                      consumed_at, consumed_by_op, requested_by_type, requested_by_id, decided_by, decided_at, auto_by)
  values (v_t.workspace_id, v_t.id, p_run.id, 'action', p_action, v_hash, p_params, p_artifact_id, v_ver,
          '', array['approve'], case when p_consumed then 'consumed' else 'decided' end, 'approve',
          jsonb_build_object('auto', true, 'by', p_by, 'level', v_level),
          case when p_consumed then null else gen_random_uuid() end,
          case when p_consumed then null else now() + interval '15 minutes' end,
          case when p_consumed then now() end, case when p_consumed then 'begin_external_op' end,
          'system', p_run.agent_id, null, now(), p_by)
  returning * into v_a;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, p_run.id, private.next_seq(v_t.id), 'action',
          jsonb_build_object('op', 'auto_approval', 'approval_id', v_a.id, 'action', p_action, 'by', p_by, 'level', v_level,
                             'summary', 'Approved automatically: ' || p_action
                                        || case p_by when 'preset' then ' (autonomy ' || v_level || ')' when 'condition' then ' (its conditions hold)' else ' (preapproved in the brief)' end),
          'system', p_run.agent_id);
  insert into public.audit_events (workspace_id, actor_id, actor_type, run_id, action, target)
  values (v_t.workspace_id, null, 'system', p_run.id, 'approval.auto',
          jsonb_build_object('approval_id', v_a.id, 'task_id', v_t.id, 'action', p_action, 'by', p_by, 'level', v_level));
  return jsonb_build_object('approval_id', v_a.id, 'action_hash', v_hash, 'status', 'approved', 'receipt', v_a.receipt,
                            'receipt_expires_at', v_a.receipt_expires_at, 'auto_approved', jsonb_build_object('by', p_by, 'level', v_level));
end $$;

-- Full copy of request_approval (0020).
create or replace function public.request_approval(p_run_id uuid, p_action text, p_params jsonb, p_artifact_id uuid default null,
  p_question text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_res jsonb; v_by text;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') or v_r.stop_requested_at is not null
     or not exists(select 1 from public.agent_tasks t where t.id=v_r.task_id and t.active_run_id=v_r.id) then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_action, '') = '' or jsonb_typeof(coalesce(p_params, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  v_by := private.action_allowed(p_action, v_r.task_id);
  if v_by is null and private.conditional_allowed(p_action, v_r, coalesce(p_params, '{}'::jsonb)) then v_by := 'condition'; end if;
  if v_by is not null then
    return private.record_auto_approval(v_r, p_action, coalesce(p_params, '{}'::jsonb), p_artifact_id, v_by, false);
  end if;
  v_res := private.request_approval_core(v_r, p_action, p_params, p_artifact_id, p_question);
  return jsonb_build_object('approval_id', v_res->'approval_id', 'action_hash', v_res->'action_hash', 'status', 'pending');
end $$;

-- Full copy of begin_external_op (0020).
create or replace function public.begin_external_op(p_run_id uuid, p_provider text, p_action text, p_params jsonb,
  p_approval_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_hash text; v_op public.external_ops%rowtype; v_approval uuid; v_auto uuid; v_ver int; v_res jsonb;
        v_by text; v_receipt uuid := p_approval_receipt;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') or v_r.stop_requested_at is not null
     or not exists(select 1 from public.agent_tasks t where t.id=v_r.task_id and t.active_run_id=v_r.id) then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_provider, '') = '' or coalesce(p_action, '') = '' or jsonb_typeof(p_params) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_provider || '|' || p_action || '|' || p_params::text, 'utf8'), 'sha256'), 'hex');
  select * into v_op from public.external_ops
   where run_id = v_r.id and params_hash = v_hash and status in ('pending','unknown') order by created_at limit 1;
  if found and exists(select 1 from public.agent_approvals where id=v_op.approval_id and auto_by is null
      and status='consumed' and decision in ('approve','edit') and receipt_expires_at>now()) then
    return jsonb_build_object('op_id',v_op.op_id,'idempotency_key',v_op.idempotency_key,'status',v_op.status);
  end if;
  -- Every other retry reauthorizes against current policy and proof, regardless of its historical auto_by.

  v_by := private.action_allowed(p_action, v_r.task_id);
  -- Checked again here: a new commit or a red run between the approval and the act sends it to a person.
  if v_by is null and private.conditional_allowed(p_action, v_r, p_params) then v_by := 'condition'; end if;
  if exists(select 1 from public.agent_approvals where receipt=v_receipt and auto_by is not null
      and auto_by is distinct from v_by) then v_receipt:=null; end if;
  if v_op.op_id is not null and v_by is not null then
    return jsonb_build_object('op_id',v_op.op_id,'idempotency_key',v_op.idempotency_key,'status',v_op.status);
  end if;
  if v_by is null then
    -- The action asks a person. An approval the level granted earlier no longer counts: the level stopped allowing it.
    if v_receipt is not null and exists (select 1 from public.agent_approvals where receipt = v_receipt and auto_by is not null) then
      v_receipt := null;
    end if;
    if v_receipt is null then
      select receipt into v_auto from public.agent_approvals
       where task_id = v_r.task_id and kind = 'action' and status = 'decided' and decision in ('approve','edit') and auto_by is null
         and (auto_by is null or auto_by=v_by)
         and receipt is not null and receipt_expires_at > now() and action_hash = private.action_hash(p_action, v_r.task_id, null, p_params)
       order by decided_at desc limit 1;
      if v_auto is null then
        v_res := private.request_approval_core(v_r, p_action, p_params, null, 'Approve ' || p_action || ' via ' || p_provider || '?');
        return jsonb_build_object('status', 'approval_required', 'approval_id', v_res->'approval_id');
      end if;
      v_approval := private.consume_approval(v_auto, p_action, p_params, null, 'begin_external_op');
    else
      select artifact_version into v_ver from public.agent_approvals where receipt = v_receipt;
      v_approval := private.consume_approval(v_receipt, p_action, p_params, v_ver, 'begin_external_op');
    end if;
  else
    -- Allowed without asking. A receipt passed in is checked like any other; without one, consume an approval already
    -- granted for this action (request_approval) or record an automatic one, consumed here.
    if v_receipt is not null then
      select artifact_version into v_ver from public.agent_approvals where receipt = v_receipt;
      v_approval := private.consume_approval(v_receipt, p_action, p_params, v_ver, 'begin_external_op');
    else
      select receipt into v_auto from public.agent_approvals
       where task_id = v_r.task_id and kind = 'action' and status = 'decided' and decision in ('approve','edit')
         and (auto_by is null or auto_by=v_by)
         and receipt is not null and receipt_expires_at > now() and action_hash = private.action_hash(p_action, v_r.task_id, null, p_params)
       order by decided_at desc limit 1;
      if v_auto is not null then
        v_approval := private.consume_approval(v_auto, p_action, p_params, null, 'begin_external_op');
      else
        v_approval := (private.record_auto_approval(v_r, p_action, p_params, null, v_by, true) ->> 'approval_id')::uuid;
      end if;
    end if;
  end if;

  if v_op.op_id is not null then
    update public.external_ops set approval_id=v_approval where op_id=v_op.op_id;
    return jsonb_build_object('op_id',v_op.op_id,'idempotency_key',v_op.idempotency_key,'status',v_op.status);
  end if;

  insert into public.external_ops (workspace_id, task_id, run_id, provider, action, params_hash, params, idempotency_key, approval_id)
  values (v_r.workspace_id, v_r.task_id, v_r.id, p_provider, p_action, v_hash, p_params, gen_random_uuid()::text, v_approval)
  returning * into v_op;
  return jsonb_build_object('op_id', v_op.op_id, 'idempotency_key', v_op.idempotency_key, 'status', v_op.status);
end $$;

-- Full current definitions from 0020; trust is now per action.
create or replace function private.action_allowed(p_action text, p_task_id uuid, p_depth int default 0)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_required text[];
begin
  if p_action = 'payment' then return null; end if;
  if p_depth >= 10 or coalesce(p_action, '') = '' then return null; end if;
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found then return null; end if;
  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  -- Fails closed: an action it names asks, and a shape it cannot read makes every action ask.
  v_required := private.required_actions(v_b.policies);
  if v_required is null or p_action = any (v_required) then return null; end if;
  if v_t.parent_task_id is not null and private.action_allowed(p_action, v_t.parent_task_id, p_depth + 1) is null then
    return null;
  end if;
  if p_action = any (private.autonomy_preset(private.task_autonomy_level(v_t.id))) then return 'preset'; end if;
  if jsonb_typeof(v_b.policies -> 'preapproved') = 'array' and (v_b.policies -> 'preapproved') ? p_action
     and private.policy_action_trusted(v_b,p_action) then
    return 'brief';
  end if;
  return null;
end $$;

create or replace function public.task_autonomy(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_req text; v_own text; v_level text; v_auto text[];
        v_candidates text[];
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found or not private.can_read_task(p_task_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select * into v_b from public.task_briefs where task_id = v_t.id and version = v_t.brief_version;
  select autonomy into v_req from public.agent_task_policies where task_id = v_t.id;
  v_own := private.own_autonomy_level(v_t.id);
  v_level := private.task_autonomy_level(v_t.id);
  -- The actions that can ever run without asking: the highest preset and what the brief preapproves.
  select coalesce(array_agg(s.a order by s.a), '{}') into v_candidates
    from (select distinct x as a
            from unnest(private.autonomy_preset('autonomous')
                        || coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_b.policies->'preapproved') = 'array'
                                                                                 then v_b.policies->'preapproved' else '[]'::jsonb end)), '{}')) x) s;
  select coalesce(array_agg(c order by c), '{}') into v_auto from unnest(v_candidates) c where private.action_allowed(c, v_t.id) is not null;
  return jsonb_build_object(
    'level', v_level, 'requested', v_req,
    'source', case when v_level <> v_own then 'parent' when v_req is not null and v_own = v_req then 'task' else 'workspace' end,
    'workspace_level', private.workspace_autonomy(v_t.workspace_id),
    'auto_approved', to_jsonb(v_auto),
    'merge_rule', private.merge_rule_state(v_t.id),
    -- What the brief makes ask, always as a list; for a shape the server cannot read, every action that could run alone.
    'require_approval', to_jsonb(coalesce(private.required_actions(v_b.policies), v_candidates)),
    -- Whether set_task_autonomy would let the caller change the level: the workspace owner, from the app itself.
    'can_edit', private.is_workspace_owner(v_t.workspace_id) and private.jwt_client_id() is null);
end $$;
