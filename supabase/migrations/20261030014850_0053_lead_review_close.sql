-- 0053_lead_review_close: a Lead connected by OAuth can close the subtasks it verified.
-- 0033 made every deterministic check read direct-session reviews, to protect conditional effects. That also stopped
-- every OAuth Lead from closing a subtask. Closing changes nothing outside and the person still accepts the parent, so
-- an agent's review counts from any session here. A person's chat review does not, a CI criterion still needs its
-- GitHub check, and conditional effects (0035) keep calling the one-argument check, which stays direct-session only.

create or replace function private.deterministic_checks_pass(p_task_id uuid, p_lead_close boolean)
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
            where r.task_id = t.id and r.outdated_by is null and (r.direct_session or (p_lead_close and r.reviewer_type = 'agent'))
              and f->>'criterion_id' = c->>'id' and f->>'status' = 'verified'
              and coalesce(f->>'severity', 'blocking') = 'blocking'
                   and not exists (select 1 from public.agent_artifacts authored
                     where authored.task_id=t.id and private.same_artifact_ref(authored.ref,(select ref from public.agent_artifacts where id=r.artifact_id))
                       and authored.author_type = r.reviewer_type and authored.author_id = r.reviewer_id)
              -- A new commit has a different ref, so it does not supersede the old artifact or its review.
              and (c->>'check' <> 'ci' or (r.brief_version = t.brief_version

                   and (r.artifact_id, r.artifact_version) = (
                     select a.id, a.version from public.agent_artifacts a, private.ci_commit(a.ref) k
                      where a.task_id = t.id and a.kind = 'diff' and a.superseded_by is null
                        and (c->>'id') = any(a.satisfies)
                        and a.id=(select newest.id from public.agent_artifacts newest where newest.task_id=t.id and newest.kind='diff' and newest.superseded_by is null order by newest.created_at desc,newest.id desc limit 1)
                      order by a.created_at desc, a.id desc limit 1)))
              and (c->>'check' = 'ci' or (jsonb_array_length(r.evidence) > 0
                   and (c->>'command' is null or exists (
                         select 1 from jsonb_array_elements(r.evidence) e where e->>'ref' = c->>'command'))))))
     and not exists (
      select 1 from public.agent_tasks t join public.task_briefs b on b.task_id = t.id and b.version = t.brief_version,
             jsonb_array_elements(b.done_when) c
       where t.id = p_task_id and c->>'check' = 'ci' and private.ci_criterion(t, c)->>'state' <> 'passed');
$$;

create or replace function private.deterministic_checks_pass(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.deterministic_checks_pass(p_task_id, false);
$$;

revoke execute on function private.deterministic_checks_pass(uuid, boolean) from public, anon, authenticated;

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
  if v_review_run is null then perform private.require_active_task(v_parent.id); end if;
  if v_t.state <> 'ready_for_review' then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  -- CI always needs both keys, even when the parent normally lets the Lead close subtasks.
  if exists (select 1 from public.task_briefs b, jsonb_array_elements(b.done_when) c
              where b.task_id = v_t.id and b.version = v_t.brief_version and c->>'check' = 'ci') then
    v_ok := private.deterministic_checks_pass(v_t.id, true);
  else
    v_ok := coalesce(v_policies->>'subtask_close', '') = 'lead' or private.deterministic_checks_pass(v_t.id, true);
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
