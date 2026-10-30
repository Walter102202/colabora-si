-- 0030 · CI evidence: a done_when criterion with check 'ci' is proved by GitHub, not by what an agent reports.
--
-- A workspace owner connects a repository. GitHub then posts check_run events to the github-webhook function, signed
-- with a secret derived per connection, so nothing secret is stored here. A criterion {check:'ci', command:'<check
-- name>'} passes when the newest commit delivered for it has a passing run of that check, finished after the task
-- existed. The agent names the commit; only GitHub says how it went.
--
-- CI proves the result, not the review: the branch's own workflow produced it, so closing still takes a verified
-- finding from a reviewer, and the check does not replace that key.

create table public.ci_connections (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  repo             text not null check (repo ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'),
  created_by       uuid not null references auth.users(id),
  created_at       timestamptz not null default now(),
  last_delivery_at timestamptz,
  revoked_at       timestamptz
);
create unique index ci_connections_live_uidx on public.ci_connections (workspace_id, repo) where revoked_at is null;

create table public.ci_check_runs (
  connection_id uuid not null references public.ci_connections(id) on delete cascade,
  check_run_id  bigint not null,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  repo          text not null,
  head_sha      text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  head_branch   text,
  name          text not null check (length(name) between 1 and 200),
  conclusion    text not null check (conclusion in ('success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure')),
  html_url      text not null check (html_url like 'https://github.com/%'),
  app_slug      text,
  started_at    timestamptz,
  completed_at  timestamptz not null,
  received_at   timestamptz not null default now(),
  primary key (connection_id, check_run_id)
);
create index ci_check_runs_lookup_idx on public.ci_check_runs (workspace_id, repo, head_sha, name, completed_at desc);
create index agent_artifacts_commit_idx on public.agent_artifacts (workspace_id, lower(ref)) where kind = 'diff' and superseded_by is null;

alter table public.ci_connections enable row level security;
alter table public.ci_check_runs enable row level security;
create policy "members read ci connections" on public.ci_connections for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy "members read ci check runs" on public.ci_check_runs for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- The commit an artifact points at: owner/repo@<sha> or a github.com commit URL, always a full sha.
create or replace function private.ci_commit(p_ref text)
returns table (repo text, sha text) language sql immutable set search_path = '' as $$
  select m[1], m[2]
    from regexp_match(lower(coalesce(p_ref, '')), '^(?:https://github\.com/)?([a-z0-9._-]+/[a-z0-9._-]+?)(?:@|/commit/)([0-9a-f]{40})$') m
   where m is not null;
$$;

-- Where one ci criterion stands. The newest delivered commit decides, and a run older than the task proves nothing.
create or replace function private.ci_criterion(p_task public.agent_tasks, p_c jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_repo text; v_sha text; v_run public.ci_check_runs%rowtype;
        v_base jsonb := jsonb_build_object('criterion_id', p_c->>'id', 'check', p_c->>'command');
begin
  select k.repo, k.sha into v_repo, v_sha
    from public.agent_artifacts a, private.ci_commit(a.ref) k
   where a.task_id = p_task.id and a.kind = 'diff' and a.superseded_by is null and (p_c->>'id') = any (a.satisfies)
   order by a.created_at desc, a.id desc limit 1;
  if v_sha is null then return v_base || jsonb_build_object('state', 'no_commit'); end if;
  v_base := v_base || jsonb_build_object('repo', v_repo, 'sha', v_sha);
  if not exists (select 1 from public.ci_connections c
                  where c.workspace_id = p_task.workspace_id and c.repo = v_repo and c.revoked_at is null) then
    return v_base || jsonb_build_object('state', 'not_connected');
  end if;
  select * into v_run from public.ci_check_runs r
   where r.workspace_id = p_task.workspace_id and r.repo = v_repo and r.head_sha = v_sha and r.name = p_c->>'command'
     and exists (select 1 from public.ci_connections c where c.id = r.connection_id and c.revoked_at is null)
     and r.completed_at >= p_task.created_at
   order by r.completed_at desc, r.check_run_id desc limit 1;
  if not found then return v_base || jsonb_build_object('state', 'pending'); end if;
  return v_base || jsonb_build_object('state', case when v_run.conclusion = 'success' then 'passed' else 'failed' end,
    'conclusion', v_run.conclusion, 'url', v_run.html_url, 'branch', v_run.head_branch, 'completed_at', v_run.completed_at);
end $$;

-- All ci criteria of a task, for the panel, the card and get_task.
create or replace function public.task_ci_status(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype;
begin
  select * into v_t from public.agent_tasks where id = p_task_id;
  if not found or not private.can_read_page(v_t.row_page_id, v_t.workspace_id) then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  return (select coalesce(jsonb_agg(private.ci_criterion(v_t, c)), '[]'::jsonb)
            from public.task_briefs b, jsonb_array_elements(b.done_when) c
           where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'check' = 'ci');
end $$;
revoke all on function public.task_ci_status(uuid) from public, anon;
grant execute on function public.task_ci_status(uuid) to authenticated;

-- Replaces 0006: a ci criterion takes a reviewer's verified finding plus a passing run; no evidence of its own.
create or replace function private.deterministic_checks_pass(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' in ('deterministic','ci'))
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' in ('deterministic','ci')
         and not exists (
           select 1 from public.agent_reviews r, jsonb_array_elements(r.findings) f
            where r.task_id = t.id and r.outdated_by is null
              and f->>'criterion_id' = c->>'id' and f->>'status' = 'verified'
              -- A new commit has a different ref, so it does not supersede the old artifact or its review.
              and (c->>'check' <> 'ci' or (r.brief_version = t.brief_version
                   and not exists (select 1 from public.agent_artifacts authored
                     where authored.id = r.artifact_id and authored.author_type = r.reviewer_type and authored.author_id = r.reviewer_id)
                   and (r.artifact_id, r.artifact_version) = (
                     select a.id, a.version from public.agent_artifacts a, private.ci_commit(a.ref) k
                      where a.task_id = t.id and a.kind = 'diff' and a.superseded_by is null
                        and (c->>'id') = any(a.satisfies)
                      order by a.created_at desc, a.id desc limit 1)))
              and (c->>'check' = 'ci' or (jsonb_array_length(r.evidence) > 0
                   and (c->>'command' is null or exists (
                         select 1 from jsonb_array_elements(r.evidence) e where e->>'ref' = c->>'command'))))))
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' = 'ci' and private.ci_criterion(t, c)->>'state' <> 'passed');
$$;

-- Replaces 0020: a ci criterion names the check it waits for.
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
  if private.required_actions(p_brief->'policies') is null then
    raise exception using errcode = 'PT400', message = 'invalid_input',
      detail = 'policies.require_approval must be an action, a list of actions or an object keyed by action';
  end if;
end $$;

-- Replaces 0020: a delivery that covers a ci criterion names a commit.
create or replace function public.submit_for_review(p_run_id uuid, p_summary text, p_artifact_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_uncovered text[]; v_lead uuid; v_actor uuid;
begin
  v_actor := private.task_actor_agent_id();
  if v_actor is null then raise exception using errcode='PT403', message='agent_disabled'; end if;
  perform private.check_rate(v_actor);
  select * into v_r from public.agent_runs where id = p_run_id and agent_id = v_actor for update;
  if not found then raise exception using errcode='PT403', message='forbidden'; end if;
  if v_r.status not in ('running','waiting') then raise exception using errcode='PT422', message='run_not_active'; end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  if v_t.state = 'input_required' and v_t.active_run_id = v_r.id and private.task_waits_on_human(v_t.id) then
    raise exception using errcode = 'PT409', message = 'waiting_on_human',
      detail = jsonb_build_object('approval_ids', (select coalesce(jsonb_agg(a.id order by a.created_at), '[]'::jsonb)
                                                     from public.agent_approvals a
                                                    where a.task_id = v_t.id and a.status = 'pending' and a.blocking))::text;
  end if;
  if v_t.state <> 'working' or v_t.active_run_id is distinct from v_r.id then
    raise exception using errcode='PT422', message='invalid_state', detail='submit from the active run of a working task';
  end if;
  if coalesce(array_length(p_artifact_ids,1),0) = 0 then raise exception using errcode='PT422', message='artifact_required'; end if;
  if exists (select 1 from unnest(p_artifact_ids) x where not exists (
       select 1 from public.agent_artifacts a where a.id = x and a.task_id = v_t.id)) then
    raise exception using errcode='PT404', message='artifact_not_found';
  end if;

  select array_agg(c->>'id') into v_uncovered
    from public.task_briefs b, jsonb_array_elements(b.done_when) c
   where b.task_id = v_t.id and b.version = v_r.brief_version and c->>'check' <> 'human'
     and not exists (select 1 from public.agent_artifacts a where a.id = any(p_artifact_ids) and (c->>'id') = any(a.satisfies));
  if v_uncovered is not null then
    raise exception using errcode='PT422', message='criteria_uncovered', detail=to_jsonb(v_uncovered)::text;
  end if;

  -- A ci criterion is proved on a commit, so the delivery has to name one.
  select array_agg(c->>'id') into v_uncovered
    from public.task_briefs b, jsonb_array_elements(b.done_when) c
   where b.task_id = v_t.id and b.version = v_r.brief_version and c->>'check' = 'ci'
     and not exists (select 1 from public.agent_artifacts a, private.ci_commit(a.ref) k
                      where a.id = any(p_artifact_ids) and a.kind = 'diff' and (c->>'id') = any(a.satisfies));
  if v_uncovered is not null then
    raise exception using errcode='PT422', message='ci_commit_required', detail=to_jsonb(v_uncovered)::text;
  end if;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_r.id, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text',p_summary,'artifact_ids',to_jsonb(p_artifact_ids),'submit',true), 'agent', v_r.agent_id);
  update public.agent_runs  set status='completed', ended_at=now() where id = v_r.id;
  update public.agent_approvals set status = 'cancelled' where run_id = v_r.id and status = 'pending';
  update public.agent_tasks set state='ready_for_review', review_state='pending', active_run_id=null, waiting_on=null where id = v_t.id;

  select p.delegate_agent_id into v_lead from public.agent_tasks p join public.agents a on a.id=p.delegate_agent_id
   where p.id = v_t.parent_task_id and a.role='lead';
  if v_lead is not null then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.parent_task_id, null, v_lead, 'task.continue',
            jsonb_build_object('review_of', v_t.id, 'artifact_ids', to_jsonb(p_artifact_ids)), private.next_event_seq(v_t.parent_task_id));
  else
    insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, payload)
    values (v_t.workspace_id, v_t.owner_user_id, 'ready_for_review', v_t.row_page_id, v_t.id, v_r.agent_id,
            jsonb_build_object('summary', left(p_summary, 280)));
  end if;
  return jsonb_build_object('task_state','ready_for_review');
end $$;

-- ============ connections ============

-- Connecting twice returns the live connection, so the webhook setup can be shown again.
create or replace function public.create_ci_connection(p_workspace_id uuid, p_repo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_repo text := lower(btrim(coalesce(p_repo, ''))); v_id uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  if not private.is_workspace_owner(p_workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if v_repo !~ '^[a-z0-9._-]+/[a-z0-9._-]+$' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'repo must be owner/name';
  end if;
  select id into v_id from public.ci_connections where workspace_id = p_workspace_id and repo = v_repo and revoked_at is null;
  if v_id is null then
    insert into public.ci_connections (workspace_id, repo, created_by) values (p_workspace_id, v_repo, (select auth.uid()))
    returning id into v_id;
    perform private.audit(p_workspace_id, 'ci.connect', jsonb_build_object('connection_id', v_id, 'repo', v_repo));
  end if;
  return jsonb_build_object('id', v_id, 'repo', v_repo);
end $$;
revoke all on function public.create_ci_connection(uuid, text) from public, anon;
grant execute on function public.create_ci_connection(uuid, text) to authenticated;

create or replace function public.revoke_ci_connection(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.ci_connections%rowtype;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode = 'PT403', message = 'direct_session_required'; end if;
  select * into v_c from public.ci_connections where id = p_id and revoked_at is null;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.is_workspace_owner(v_c.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  update public.ci_connections set revoked_at = now() where id = v_c.id;
  perform private.audit(v_c.workspace_id, 'ci.revoke', jsonb_build_object('connection_id', v_c.id, 'repo', v_c.repo));
  return jsonb_build_object('revoked', true);
end $$;
revoke all on function public.revoke_ci_connection(uuid) from public, anon;
grant execute on function public.revoke_ci_connection(uuid) to authenticated;

-- service_role only (github-webhook, after it verified the signature). p_run null records a ping.
-- A new result leaves a line in the history of each open task delivering that commit and wakes who can act on it.
create or replace function public.record_ci_check(p_connection_id uuid, p_repo text, p_run jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.ci_connections%rowtype; v_sha text; v_name text; v_conclusion text; v_url text; v_rows int;
        v_t public.agent_tasks%rowtype; v_ci jsonb; v_passed boolean; v_tasks int := 0;
begin
  select * into v_c from public.ci_connections where id = p_connection_id;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if v_c.revoked_at is not null then raise exception using errcode = 'PT410', message = 'connection_revoked'; end if;
  if lower(coalesce(p_repo, '')) <> v_c.repo then raise exception using errcode = 'PT403', message = 'repo_mismatch'; end if;
  update public.ci_connections set last_delivery_at = now() where id = v_c.id;
  if p_run is null then return jsonb_build_object('recorded', false); end if;

  v_sha := lower(coalesce(p_run->>'head_sha', ''));
  v_name := p_run->>'name';
  v_conclusion := p_run->>'conclusion';
  v_url := p_run->>'html_url';
  begin
    insert into public.ci_check_runs (connection_id, check_run_id, workspace_id, repo, head_sha, head_branch, name, conclusion,
                                      html_url, app_slug, started_at, completed_at)
    values (v_c.id, (p_run->>'id')::bigint, v_c.workspace_id, v_c.repo, v_sha, p_run->>'head_branch', v_name, v_conclusion,
            v_url, p_run->>'app_slug', (p_run->>'started_at')::timestamptz, (p_run->>'completed_at')::timestamptz)
    on conflict (connection_id, check_run_id) do nothing;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('recorded', false); end if;

  v_passed := v_conclusion = 'success';
  v_ci := jsonb_build_object('check', v_name, 'conclusion', v_conclusion, 'sha', v_sha, 'url', v_url);
  for v_t in
    select t.* from public.agent_tasks t
     where t.workspace_id = v_c.workspace_id and t.state in ('working','input_required','ready_for_review')
       and t.created_at <= (p_run->>'completed_at')::timestamptz
       and exists (select 1 from public.agent_artifacts a
                    where a.workspace_id = v_c.workspace_id and a.task_id = t.id and a.kind = 'diff' and a.superseded_by is null
                      and lower(a.ref) in (v_c.repo || '@' || v_sha, 'https://github.com/' || v_c.repo || '/commit/' || v_sha))
       and exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
                    where b.task_id = t.id and b.version = t.brief_version and c->>'check' = 'ci' and c->>'command' = v_name)
     order by t.id for update of t
  loop
    v_tasks := v_tasks + 1;
    insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
    values (v_t.workspace_id, v_t.id, v_t.active_run_id, private.next_seq(v_t.id), 'response',
            jsonb_build_object('text', 'CI: ' || v_name || case when v_passed then ' passed on ' else ' did not pass on ' end || left(v_sha, 7) || '.', 'ci', v_ci),
            'system', v_c.created_by);
    -- The Lead decides on the subtask either way; the worker only needs to hear about a failure.
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    select p.workspace_id, p.id, p.active_run_id, p.delegate_agent_id, 'task.updated',
           jsonb_build_object('subtask_id', v_t.id, 'ci', v_ci), private.next_event_seq(p.id)
      from public.agent_tasks p
     where p.id = v_t.parent_task_id and p.delegate_agent_id is not null;
    if not v_passed and v_t.delegate_agent_id is not null then
      insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
      values (v_t.workspace_id, v_t.id, v_t.active_run_id, v_t.delegate_agent_id, 'task.updated',
              jsonb_build_object('ci', v_ci), private.next_event_seq(v_t.id));
    end if;
  end loop;
  return jsonb_build_object('recorded', true, 'tasks', v_tasks);
end $$;
revoke all on function public.record_ci_check(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_ci_check(uuid, text, jsonb) to service_role;


-- Replaces 0018: parent policy cannot override the two keys for CI evidence.
create or replace function public.close_subtask(p_task_id uuid, p_verdict text default 'accepted', p_evidence jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_t public.agent_tasks%rowtype; v_parent public.agent_tasks%rowtype; v_policies jsonb; v_ok boolean; v_review_run uuid;
begin
  v_agent := private.current_agent_id();
  if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
  perform private.check_rate(v_agent);
  if coalesce(p_verdict, '') <> 'accepted' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id and parent_task_id is not null for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  select p.* into v_parent from public.agent_tasks p where p.id = v_t.parent_task_id;
  select b.policies into v_policies from public.task_briefs b where b.task_id = v_parent.id and b.version = v_parent.brief_version;
  v_review_run := private.reviewer_run_of(v_t.id);
  if v_review_run is null and (v_parent.delegate_agent_id is distinct from v_agent
     or not exists (select 1 from public.agents where id = v_agent and role = 'lead')) then
    raise exception using errcode = 'PT403', message = 'lead_only';
  end if;
  if v_t.state <> 'ready_for_review' then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  -- CI always needs both keys, even when the parent normally lets the Lead close subtasks.
  if exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
              where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'check' = 'ci') then
    v_ok := private.deterministic_checks_pass(v_t.id);
  else
    v_ok := coalesce(v_policies->>'subtask_close', '') = 'lead' or private.deterministic_checks_pass(v_t.id);
  end if;
  if not v_ok then raise exception using errcode = 'PT422', message = 'policy_denied'; end if;

  update public.agent_tasks set state = 'done', acceptance = 'accepted', closed_at = now(), closed_by = null, active_run_id = null,
         waiting_on = null, updated_at = now()
   where id = v_t.id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'response',
          jsonb_build_object('text', case when v_review_run is not null then 'Closed by the reviewer.' else 'Closed by the lead.' end, 'verdict', p_verdict, 'evidence', coalesce(p_evidence, '[]'::jsonb),
                             'rule', case when coalesce(v_policies->>'subtask_close', '') = 'lead' then 'policy' else 'deterministic' end),
          'agent', v_agent);
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_parent.workspace_id, v_parent.id, v_parent.active_run_id, v_parent.delegate_agent_id, 'task.updated',
         jsonb_build_object('subtask_id', v_t.id, 'subtask_state', 'done', 'acceptance', 'accepted', 'closed_by', case when v_review_run is not null then 'reviewer' else 'lead' end),
         private.next_event_seq(v_parent.id)
   where v_parent.delegate_agent_id is not null;
  perform private.release_dependents(v_t.id);
  perform private.audit(v_t.workspace_id, 'task.close_subtask', jsonb_build_object('task_id', v_t.id));
  return jsonb_build_object('task_state', 'done');
end $$;

-- Replaces 0020 in full: only a person may remove or change an existing CI criterion.
create or replace function public.update_brief(p_task_id uuid, p_patch jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_b public.task_briefs%rowtype; v_agent uuid; v_full boolean := false;
        v_author uuid; v_author_type text; v_bad text; v_new jsonb; v_ver int; v_d public.agents%rowtype; v_trusted boolean;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;

  if private.is_agent() then
    v_agent := private.current_agent_id();
    if v_agent is null then raise exception using errcode = 'PT403', message = 'agent_disabled'; end if;
    perform private.check_rate(v_agent);
    if exists (select 1 from public.agent_tasks p join public.agents a on a.id = p.delegate_agent_id
                where p.id = v_t.parent_task_id and p.delegate_agent_id = v_agent and a.role = 'lead') then
      v_full := true;
    elsif v_t.delegate_agent_id = v_agent then
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
  v_new := (to_jsonb(v_b) - 'task_id' - 'version' - 'workspace_id' - 'author_id' - 'author_type' - 'created_at' - 'preapproved_trusted')
           || (p_patch - 'delegate_agent_id' - 'depends_on_task_ids');
  perform private.validate_brief(v_new);
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
  end if;
  if p_patch ? 'depends_on_task_ids' and exists (
       select 1 from jsonb_array_elements_text(p_patch->'depends_on_task_ids') d
        where not exists (select 1 from public.agent_tasks x where x.id = d::uuid and x.context_id = v_t.context_id and x.id <> v_t.id)) then
    raise exception using errcode = 'PT422', message = 'invalid_dependency';
  end if;

  v_ver := v_t.brief_version + 1;
  -- The preapproved list keeps its trust while it does not change; a new list is trusted only when a person writes it
  -- from the app itself.
  v_trusted := case
    when (coalesce(v_new->'policies', '{}'::jsonb) -> 'preapproved') is not distinct from (v_b.policies -> 'preapproved')
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

  if p_patch ? 'delegate_agent_id' and v_d.id is not null then
    perform private.ensure_delegate_grants(v_d.id, v_t.workspace_id, v_t.row_page_id, v_new->'sources');
  end if;
  perform private.audit(v_t.workspace_id, 'brief.update', jsonb_build_object('task_id', v_t.id, 'version', v_ver));
  return v_ver;
end $$;
