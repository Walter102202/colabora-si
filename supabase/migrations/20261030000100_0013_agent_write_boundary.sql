-- 0013 · Agent write boundary.
--
-- Agents write pages only through the partial RPCs of 0005 (escaped HTML, filtered hrefs, rate limit,
-- an `action` activity carrying the inverse ops). apply_page_ops is the client's whole-ops entry: it
-- never recorded an activity for an agent, so an agent with a write grant could write without a trace.
-- Reopening a closed task is a decision of a person: claim_task no longer takes `done` tasks and
-- send_agent_message refuses to reopen for an agent principal (a Lead on its subtask).

-- ============ apply_page_ops: people only ============

create or replace function public.apply_page_ops(p_page_id text, p_ops jsonb, p_client text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_result jsonb; v_scope text := 'page:' || p_page_id;
begin
  -- Agents write through the partial RPCs of 0005; see the header of this migration.
  if private.is_agent() then raise exception using errcode = 'PT403', message = 'use_partial_writes'; end if;
  select workspace_id into v_ws from public.pages where id = p_page_id;
  if v_ws is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not coalesce(private.can_write_page(p_page_id,v_ws),false) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_scope || ':' || p_idempotency_key || ':' || auth.uid()::text,0));
    select result into v_result from private.write_receipts where scope = v_scope and key = p_idempotency_key and actor_id = auth.uid();
    if found then return v_result; end if;
  end if;
  v_result := private.apply_page_ops_core(p_page_id,p_ops,p_client) - 'inverse';
  if p_idempotency_key is not null then insert into private.write_receipts(scope,key,actor_id,result) values(v_scope,p_idempotency_key,auth.uid(),v_result); end if;
  return v_result;
end;
$$;
revoke all on function public.apply_page_ops(text,jsonb,text,text) from public,anon;
grant execute on function public.apply_page_ops(text,jsonb,text,text) to authenticated;

-- ============ claim_task: done is final for agents ============

create or replace function public.claim_task(p_task_id uuid default null, p_harness text default 'custom',
  p_external_session_id text default null, p_brief_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_task public.agent_tasks%rowtype; v_run uuid; v_brief jsonb; v_ver int;
begin
  v_agent := private.task_actor_agent_id();
  if v_agent is null then raise exception using errcode='PT403', message='agent_disabled'; end if;
  perform private.check_rate(v_agent);

  select t.* into v_task from public.agent_tasks t
   where (p_task_id is null or t.id = p_task_id)
     and t.state in ('queued','input_required','ready_for_review')
     and (t.delegate_agent_id = v_agent
          or (t.delegate_agent_id is null and private.agent_can(t.row_page_id,'write')))
     and (p_task_id is not null or t.state = 'queued')
   order by t.created_at
   for update skip locked limit 1;
  if not found then
    if p_task_id is null then return jsonb_build_object('task_id', null); end if;
    raise exception using errcode='PT409', message='task_unavailable';
  end if;
  if v_task.active_run_id is not null then raise exception using errcode='PT409', message='run_active'; end if;

  select max(version) into v_ver from public.task_briefs where task_id = v_task.id;
  if p_brief_version is not null and p_brief_version <> v_ver then
    raise exception using errcode='PT422', message='brief_version_stale', detail=jsonb_build_object('current', v_ver)::text;
  end if;

  insert into public.agent_runs (workspace_id, task_id, agent_id, harness, external_session_id, brief_version)
  values (v_task.workspace_id, v_task.id, v_agent, p_harness, p_external_session_id, v_ver)
  returning id into v_run;

  update public.agent_tasks set state='working', waiting_on=null, active_run_id=v_run,
         brief_stale=false, delegate_agent_id=coalesce(delegate_agent_id, v_agent), updated_at=now()
   where id = v_task.id;

  perform set_config('app.run_id', v_run::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_task.workspace_id, v_task.id, v_run, private.next_seq(v_task.id), 'action',
          jsonb_build_object('op','claim','harness',p_harness,'brief_version',v_ver), 'agent', v_agent);

  select to_jsonb(b) into v_brief from public.task_briefs b where b.task_id=v_task.id and b.version=v_ver;
  return jsonb_build_object(
    'task_id', v_task.id, 'run_id', v_run, 'context_id', v_task.context_id,
    'row_page_id', v_task.row_page_id, 'brief', v_brief,
    'artifacts', (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.agent_artifacts a
                   where a.task_id=v_task.id and a.superseded_by is null),
    'recent_activities', (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
        select type, body, author_type, created_at from public.agent_activities
         where task_id=v_task.id and not ephemeral order by seq desc limit 20) x));
end $$;
revoke all on function public.claim_task(uuid, text, text, int) from public, anon;
grant execute on function public.claim_task(uuid, text, text, int) to authenticated;
