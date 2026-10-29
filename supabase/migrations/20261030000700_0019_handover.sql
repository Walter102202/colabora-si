-- 0019_handover: checkpoints and handover between harnesses. Run review and revert are appended
-- below the marker at the end of this file. Bodies replaced here are full copies; never edit 0002, 0005, 0006 or 0013.

alter table public.agent_activities drop constraint agent_activities_type_check;
alter table public.agent_activities add constraint agent_activities_type_check
  check (type in ('thought','action','elicitation','response','error','prompt','checkpoint','handover'));

-- ============ checkpoint format ============

create or replace function private.checkpoint_v1(p_checkpoint jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_path text; v_key text; v_group text; v_list text; v_item jsonb; v_value jsonb;
        v_i bigint; v_j bigint; v_allowed text[]; v_required text[]; v_min int; v_max int;
begin
  if pg_column_size(p_checkpoint) > 262144 then
    raise exception using errcode = 'PT400', message = 'invalid_input',
      detail = '{"path":"$","max_bytes":262144}';
  end if;
  v_path := '$';
  if jsonb_typeof(p_checkpoint) is distinct from 'object' then raise invalid_parameter_value; end if;
  for v_key in select jsonb_object_keys(p_checkpoint) loop
    v_path := '$.' || v_key;
    if v_key not in ('v','next_step','ops','effects','evidence','handover_note') then raise invalid_parameter_value; end if;
  end loop;
  v_path := '$.v';
  if jsonb_typeof(p_checkpoint->'v') is distinct from 'number' then raise invalid_parameter_value; end if;
  if (p_checkpoint->>'v')::numeric <> trunc((p_checkpoint->>'v')::numeric) then raise invalid_parameter_value; end if;
  if (p_checkpoint->>'v')::numeric <> 1 then
    raise exception using errcode = 'PT422', message = 'checkpoint_version_unsupported',
      detail = jsonb_build_object('supported', jsonb_build_array(1), 'got', p_checkpoint->'v')::text;
  end if;
  v_path := '$.next_step';
  if jsonb_typeof(p_checkpoint->'next_step') is distinct from 'string'
     or char_length(p_checkpoint->>'next_step') not between 1 and 2000 then raise invalid_parameter_value; end if;
  v_path := '$.handover_note';
  -- A JSON null reads as absent: it is what checkpoint_read returns for a checkpoint without a note.
  if p_checkpoint ? 'handover_note' and jsonb_typeof(p_checkpoint->'handover_note') <> 'null'
     and (jsonb_typeof(p_checkpoint->'handover_note') <> 'string'
     or char_length(p_checkpoint->>'handover_note') > 4000) then raise invalid_parameter_value; end if;

  foreach v_group in array array['ops','effects','evidence'] loop
    v_path := '$.' || v_group;
    if not (p_checkpoint ? v_group) then continue; end if;
    if v_group <> 'evidence' then
      if jsonb_typeof(p_checkpoint->v_group) <> 'object' then raise invalid_parameter_value; end if;
      for v_key in select jsonb_object_keys(p_checkpoint->v_group) loop
        v_path := '$.' || v_group || '.' || v_key;
        if (v_group = 'ops' and v_key not in ('confirmed','pending'))
           or (v_group = 'effects' and v_key not in ('confirmed','not_executed','unknown')) then raise invalid_parameter_value; end if;
      end loop;
    end if;
    for v_list, v_value in
      select key, value from jsonb_each(case when v_group = 'evidence'
        then jsonb_build_object('evidence', p_checkpoint->v_group) else p_checkpoint->v_group end)
    loop
      v_path := case when v_group = 'evidence' then '$.evidence' else '$.' || v_group || '.' || v_list end;
      if jsonb_typeof(v_value) <> 'array' then raise invalid_parameter_value; end if;
      if jsonb_array_length(v_value) > (case when v_group = 'ops' then 200 else 50 end) then raise invalid_parameter_value; end if;
      for v_item, v_i in select value, ordinality - 1 from jsonb_array_elements(v_value) with ordinality loop
        v_path := case when v_group = 'evidence' then '$.evidence' else '$.' || v_group || '.' || v_list end || '[' || v_i || ']';
        if jsonb_typeof(v_item) <> 'object' then raise invalid_parameter_value; end if;
        v_allowed := case v_group when 'ops' then array['key','tool','summary','page_id','block_ids','args_hash']
          when 'effects' then array['action','summary','external_op_id','approval_id']
          else array['criterion_id','status','refs','note'] end;
        v_required := case v_group when 'ops' then array['key','tool'] when 'effects' then array['action'] else array['criterion_id','status'] end;
        foreach v_key in array v_required loop
          if not (v_item ? v_key) then v_path := v_path || '.' || v_key; raise invalid_parameter_value; end if;
        end loop;
        for v_key in select jsonb_object_keys(v_item) loop
          v_path := case when v_group = 'evidence' then '$.evidence' else '$.' || v_group || '.' || v_list end || '[' || v_i || '].' || v_key;
          if not (v_key = any(v_allowed)) then raise invalid_parameter_value; end if;
          if v_key in ('block_ids','refs') then
            if jsonb_typeof(v_item->v_key) <> 'array' then raise invalid_parameter_value; end if;
            if jsonb_array_length(v_item->v_key) > (case v_key when 'block_ids' then 200 else 20 end) then raise invalid_parameter_value; end if;
            for v_j in select generate_series(0, jsonb_array_length(v_item->v_key) - 1) loop
              v_path := case when v_group = 'evidence' then '$.evidence' else '$.' || v_group || '.' || v_list end || '[' || v_i || '].' || v_key || '[' || v_j || ']';
              if jsonb_typeof(v_item->v_key->(v_j::int)) <> 'string'
                 or char_length(v_item->v_key->>(v_j::int)) not between (case v_key when 'block_ids' then 1 else 0 end)
                   and (case v_key when 'block_ids' then 64 else 500 end) then raise invalid_parameter_value; end if;
            end loop;
          else
            if jsonb_typeof(v_item->v_key) <> 'string' then raise invalid_parameter_value; end if;
            v_min := case when v_key = any(v_required) then 1 else 0 end;
            v_max := case v_key when 'key' then 200 when 'tool' then 60 when 'summary' then 280 when 'page_id' then 64
              when 'args_hash' then 128 when 'action' then 200 when 'criterion_id' then 60 when 'note' then 1000 else 36 end;
            if char_length(v_item->>v_key) not between v_min and v_max then raise invalid_parameter_value; end if;
            if v_key = 'status' and v_item->>v_key not in ('met','unmet','unknown') then raise invalid_parameter_value; end if;
            if v_key in ('external_op_id','approval_id') then
              begin perform (v_item->>v_key)::uuid;
              exception when invalid_text_representation then raise invalid_parameter_value; end;
            end if;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  return private.checkpoint_read(p_checkpoint)->'checkpoint';
exception when invalid_parameter_value then
  raise exception using errcode = 'PT400', message = 'invalid_input', detail = jsonb_build_object('path', v_path)::text;
end $$;

-- Readers tolerate incomplete older bodies and never let a malformed activity break a claim.
create or replace function private.checkpoint_read(p_body jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_cp jsonb; v_group text; v_key text; v_obj jsonb;
begin
  if jsonb_typeof(p_body->'v') is distinct from 'number' or p_body->'v' <> '1'::jsonb then
    return jsonb_build_object('readable', false, 'version', p_body->'v', 'checkpoint', null);
  end if;
  v_cp := jsonb_build_object('v', 1, 'next_step', coalesce(p_body->>'next_step', ''),
    'handover_note', p_body->>'handover_note');
  foreach v_group in array array['ops','effects'] loop
    v_obj := '{}';
    foreach v_key in array (case v_group when 'ops' then array['confirmed','pending'] else array['confirmed','not_executed','unknown'] end) loop
      v_obj := v_obj || jsonb_build_object(v_key, case when jsonb_typeof(p_body->v_group->v_key) = 'array'
        then p_body->v_group->v_key else '[]'::jsonb end);
    end loop;
    v_cp := v_cp || jsonb_build_object(v_group, v_obj);
  end loop;
  v_cp := v_cp || jsonb_build_object('evidence', case when jsonb_typeof(p_body->'evidence') = 'array' then p_body->'evidence' else '[]'::jsonb end);
  return jsonb_build_object('readable', true, 'version', 1, 'checkpoint', v_cp);
exception when others then
  return jsonb_build_object('readable', false, 'version', p_body->'v', 'checkpoint', null);
end $$;

create or replace function private.receipt_scope(p_tool text)
returns text language sql immutable set search_path = '' as $$
  select case p_tool when 'append_blocks' then 'append_page_blocks' when 'edit_page' then 'edit_block_text'
    when 'update_block' then 'update_block' when 'update_row' then 'set_row_cells' when 'add_row' then 'add_row' end;
$$;

create or replace function private.detach_task_links(p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_approvals set run_id = null where run_id = p_run_id and status in ('pending','decided');
  update public.external_ops set run_id = null where run_id = p_run_id and status in ('pending','unknown');
end $$;

create or replace function private.task_waits_on_human(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agent_approvals where task_id = p_task_id and status = 'pending');
$$;

create or replace function public.save_checkpoint(p_run_id uuid, p_checkpoint jsonb, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_a public.agent_activities%rowtype; v_cp jsonb;
begin
  v_r := private.own_run(p_run_id);
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = '{"path":"idempotency_key"}';
  end if;
  select * into v_a from public.agent_activities where task_id = v_r.task_id and idempotency_key = p_idempotency_key;
  if found and v_a.type <> 'checkpoint' then raise exception using errcode = 'PT409', message = 'idempotency_conflict'; end if;
  if found then return jsonb_build_object('activity_id', v_a.id, 'seq', v_a.seq, 'replayed', true); end if;
  if v_r.status not in ('running','waiting') or not exists (
    select 1 from public.agent_tasks where id = v_r.task_id and active_run_id = v_r.id) then
    raise exception using errcode = 'PT422', message = 'run_not_active';
  end if;
  v_cp := private.checkpoint_v1(p_checkpoint);
  perform set_config('app.run_id', v_r.id::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id, ephemeral, idempotency_key)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), 'checkpoint',
    v_cp || jsonb_build_object('harness', v_r.harness, 'handover', false), 'agent', v_r.agent_id, true, p_idempotency_key)
  returning * into v_a;
  return jsonb_build_object('activity_id', v_a.id, 'seq', v_a.seq, 'replayed', false);
end $$;

create or replace function public.hand_over(p_run_id uuid, p_checkpoint jsonb, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_a public.agent_activities%rowtype; v_t public.agent_tasks%rowtype; v_cp jsonb;
begin
  v_r := private.own_run(p_run_id);
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = '{"path":"idempotency_key"}';
  end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id for update;
  select * into v_a from public.agent_activities where task_id = v_r.task_id and idempotency_key = p_idempotency_key;
  -- Only an earlier hand_over replays: the key of an intent checkpoint would report a handover that never happened.
  if found and (v_a.type <> 'checkpoint' or v_a.body->'handover' is distinct from 'true'::jsonb) then
    raise exception using errcode = 'PT409', message = 'idempotency_conflict';
  end if;
  if found then return jsonb_build_object('activity_id', v_a.id, 'seq', v_a.seq, 'task_state', v_t.state, 'replayed', true); end if;
  if v_r.status not in ('running','waiting') or v_t.active_run_id is distinct from v_r.id then
    raise exception using errcode = 'PT422', message = 'run_not_active';
  end if;
  -- A person's stop wins: the agent acknowledges it with ack_stop instead of queueing the task again.
  if v_r.stop_requested_at is not null then raise exception using errcode = 'PT409', message = 'stop_requested'; end if;
  v_cp := private.checkpoint_v1(p_checkpoint);
  if coalesce(v_cp->>'handover_note', '') = '' then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = '{"path":"$.handover_note"}';
  end if;
  perform set_config('app.run_id', v_r.id::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id, ephemeral, idempotency_key)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), 'checkpoint',
    v_cp || jsonb_build_object('harness', v_r.harness, 'handover', true), 'agent', v_r.agent_id, false, p_idempotency_key)
  returning * into v_a;
  perform private.detach_task_links(v_r.id);
  update public.agent_runs set status = 'completed', ended_at = now() where id = v_r.id;
  update public.agent_tasks set active_run_id = null,
    state = case when private.task_waits_on_human(v_t.id) then 'input_required' else 'queued' end,
    waiting_on = case when private.task_waits_on_human(v_t.id) then 'human' end, updated_at = now()
    where id = v_t.id and state in ('working','input_required') returning * into v_t;
  insert into public.notifications (workspace_id, user_id, kind, page_id, task_id, actor_id, actor_type, payload)
  values (v_t.workspace_id, v_t.owner_user_id, 'input_required', v_t.row_page_id, v_t.id, v_r.agent_id, 'agent',
    jsonb_build_object('handover', true, 'from_harness', v_r.harness, 'note', left(v_cp->>'handover_note', 280)));
  perform private.audit(v_t.workspace_id, 'task.handover', jsonb_build_object('task_id', v_t.id, 'run_id', v_r.id, 'harness', v_r.harness, 'by', 'agent'));
  return jsonb_build_object('activity_id', v_a.id, 'seq', v_a.seq, 'task_state', v_t.state, 'replayed', false);
end $$;

-- ============ release and resume ============

create or replace function public.release_for_handover(p_task_id uuid, p_to_agent_id uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.agent_tasks%rowtype; v_r public.agent_runs%rowtype; v_from uuid;
begin
  if private.principal_type() <> 'human' then raise exception using errcode = 'PT403', message = 'humans_only'; end if;
  select * into v_t from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then raise exception using errcode = 'PT403', message = 'forbidden'; end if;
  if v_t.state not in ('queued','working','input_required') then raise exception using errcode = 'PT422', message = 'invalid_state'; end if;
  if char_length(p_note) > 4000 then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  if p_to_agent_id is not null and not exists (
    select 1 from public.agents where id = p_to_agent_id and workspace_id = v_t.workspace_id and status = 'enabled' and revoked_at is null) then
    raise exception using errcode = 'PT404', message = 'delegate_not_found';
  end if;
  v_from := v_t.active_run_id;
  if v_from is not null then
    perform private.detach_task_links(v_from);
    update public.agent_runs set status = 'cancelled', stop_requested_at = coalesce(stop_requested_at, now()),
      ended_at = now(), error_message = 'released for handover by a person' where id = v_from returning * into v_r;
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.id, v_r.id, v_r.agent_id, 'task.stop', jsonb_build_object('reason', 'handover'), private.next_event_seq(v_t.id));
  else
    -- The last run that ended, ordered by its claim activity as resume_context does (timestamps tie inside one transaction).
    select r.* into v_r from public.agent_runs r where r.task_id = v_t.id and r.status in ('completed','cancelled','error')
     order by (select min(a.seq) from public.agent_activities a where a.task_id = v_t.id and a.run_id = r.id) desc nulls last,
              r.started_at desc, r.id limit 1;
  end if;
  if p_to_agent_id is not null then
    perform private.ensure_delegate_grants(p_to_agent_id, v_t.workspace_id, v_t.row_page_id,
      (select sources from public.task_briefs where task_id = v_t.id and version = v_t.brief_version));
  end if;
  update public.agent_tasks set delegate_agent_id = coalesce(p_to_agent_id, delegate_agent_id), active_run_id = null,
    state = case when private.task_waits_on_human(v_t.id) then 'input_required' else 'queued' end,
    waiting_on = case when private.task_waits_on_human(v_t.id) then 'human' end, updated_at = now()
    where id = v_t.id returning * into v_t;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, null, private.next_seq(v_t.id), 'prompt',
    jsonb_build_object('signal', 'continue', 'source', 'handover', 'handover', true, 'from_run_id', v_r.id,
      'to_agent_id', v_t.delegate_agent_id, 'text', coalesce(p_note, '')), 'human', auth.uid());
  if exists (select 1 from public.agents where id = v_t.delegate_agent_id and capabilities->'continue' = 'true'::jsonb) then
    insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
    values (v_t.workspace_id, v_t.id, null, v_t.delegate_agent_id, 'task.continue',
      jsonb_build_object('handover', true, 'context_id', v_t.context_id, 'brief_version', v_t.brief_version,
        'from_harness', v_r.harness, 'note', left(coalesce(p_note, ''), 280)), private.next_event_seq(v_t.id));
  end if;
  perform private.audit(v_t.workspace_id, 'task.handover', jsonb_build_object('task_id', v_t.id, 'from_run_id', v_r.id, 'to_agent_id', v_t.delegate_agent_id, 'by', 'human'));
  return jsonb_build_object('task_state', v_t.state, 'delegate_agent_id', v_t.delegate_agent_id, 'cancelled_run_id', v_from);
end $$;

create or replace function private.resume_context(p_task_id uuid, p_new_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cp public.agent_activities%rowtype; v_from public.agent_runs%rowtype; v_cp_run public.agent_runs%rowtype; v_read jsonb; v_body jsonb;
        v_actor uuid; v_ws uuid; v_op jsonb; v_receipt jsonb; v_status text; v_pending jsonb := '[]';
        v_blocks jsonb := '[]'; v_approvals jsonb; v_external jsonb; v_counts jsonb; v_summary text;
        v_pair record; v_data jsonb; v_block jsonb; v_path text[]; v_stale boolean;
begin
  select workspace_id into v_ws from public.agent_tasks where id = p_task_id;
  select * into v_cp from public.agent_activities where task_id = p_task_id and type = 'checkpoint' order by seq desc limit 1;
  select * into v_cp_run from public.agent_runs where id = v_cp.run_id;
  -- "from" is the last run that ended, ordered by its claim activity (timestamps tie inside one transaction).
  select r.* into v_from from public.agent_runs r where r.task_id = p_task_id and r.id <> p_new_run_id
     and r.status in ('completed','cancelled','error')
   order by (select min(a.seq) from public.agent_activities a where a.task_id = p_task_id and a.run_id = r.id) desc nulls last,
            r.started_at desc, r.id limit 1;
  if v_from.id is null then v_from := v_cp_run; end if;
  -- A later run that saved no checkpoint may have done the pending writes itself: they are unknown, not not_executed.
  v_stale := v_cp.id is not null and v_from.id is distinct from v_cp.run_id;
  v_read := private.checkpoint_read(v_cp.body);
  v_body := v_read->'checkpoint';
  select a.auth_user_id into v_actor from public.agents a where a.id = v_cp_run.agent_id;
  for v_op in select value from jsonb_array_elements(coalesce(v_body->'ops'->'pending', '[]')) where jsonb_typeof(value) = 'object' loop
    select result into v_receipt from private.write_receipts
      where scope = private.receipt_scope(v_op->>'tool') and key = v_op->>'key' and actor_id = v_actor;
    v_status := case when found then 'confirmed'
      when not v_stale and private.receipt_scope(v_op->>'tool') is not null and v_cp.created_at > now() - interval '47 hours' then 'not_executed' else 'unknown' end;
    v_pending := v_pending || jsonb_build_array(v_op || jsonb_build_object('status', v_status)
      || case when v_status = 'confirmed' then jsonb_build_object('result', v_receipt) else '{}'::jsonb end);
  end loop;
  for v_pair in
    with ops as (
      select value as op from jsonb_array_elements(coalesce(v_body->'ops'->'confirmed', '[]') || v_pending)
    ), ids as (
      select op->>'page_id' as page_id, id #>> '{}' as block_id from ops,
        lateral jsonb_array_elements(case when jsonb_typeof(op->'block_ids') = 'array' then op->'block_ids' else '[]'::jsonb end
          || case when jsonb_typeof(op->'result'->'block_ids') = 'array' then op->'result'->'block_ids' else '[]'::jsonb end) id
      where jsonb_typeof(id) = 'string'
    ) select distinct page_id, block_id from ids where private.can_read_page(page_id, v_ws) order by page_id, block_id limit 200
  loop
    select data into v_data from public.pages where id = v_pair.page_id and workspace_id = v_ws;
    v_path := private.block_path(v_data, v_pair.block_id);
    v_block := v_data #> v_path;
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object('page_id', v_pair.page_id, 'block_id', v_pair.block_id,
      'exists', v_path is not null, 'rev', v_block->'rev', 'last_by', v_block->'attr'->>'by',
      'changed_by_other', v_path is not null and not exists (
        select 1 from public.agent_runs where task_id = p_task_id and id::text = v_block->'attr'->>'runId')));
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'action', action, 'status', status, 'decision', decision,
    'question', question, 'params', params, 'created_at', created_at) order by created_at), '[]') into v_approvals
    from public.agent_approvals where task_id = p_task_id and status in ('pending','decided');
  select coalesce(jsonb_agg(jsonb_build_object('op_id', op_id, 'provider', provider, 'action', action, 'status', status,
    'created_at', created_at) order by created_at), '[]') into v_external
    from public.external_ops where task_id = p_task_id and status in ('pending','unknown');
  v_counts := jsonb_build_object(
    'confirmed', (select count(*) from jsonb_array_elements(v_pending) x where x->>'status' = 'confirmed'),
    'not_executed', (select count(*) from jsonb_array_elements(v_pending) x where x->>'status' = 'not_executed'),
    'unknown', (select count(*) from jsonb_array_elements(v_pending) x where x->>'status' = 'unknown'),
    'blocks_changed', (select count(*) from jsonb_array_elements(v_blocks) x where x->'changed_by_other' = 'true'::jsonb),
    'approvals_pending', (select count(*) from jsonb_array_elements(v_approvals) x where x->>'status' = 'pending'),
    'external_open', jsonb_array_length(v_external));
  v_summary := left(case when v_cp.id is null then 'No checkpoint yet.' else
    case when v_stale then format('The last run (%s) saved no checkpoint, so pending writes without a receipt are unknown. ', coalesce(v_from.harness, 'unknown')) else '' end
    || format(
    'Continuing from checkpoint #%s by %s: %s pending write(s) already happened, %s did not, %s unknown; %s block(s) changed by someone else; %s approval(s) pending.',
    v_cp.seq, coalesce(v_cp.body->>'harness', v_cp_run.harness, 'unknown'), v_counts->>'confirmed', v_counts->>'not_executed',
    v_counts->>'unknown', v_counts->>'blocks_changed', v_counts->>'approvals_pending') end, 500);
  return jsonb_build_object(
    'checkpoint', case when v_cp.id is not null then jsonb_build_object('seq', v_cp.seq, 'created_at', v_cp.created_at,
      'run_id', v_cp.run_id, 'harness', v_cp.body->>'harness', 'readable', v_read->'readable', 'version', v_read->'version', 'stale', v_stale,
      'body', case when v_read->'readable' = 'true'::jsonb then v_body || jsonb_build_object('harness', v_cp.body->'harness', 'handover', v_cp.body->'handover') else null end) end,
    'from', case when v_from.id is not null then jsonb_build_object('run_id', v_from.id, 'agent_id', v_from.agent_id,
      'harness', v_from.harness, 'status', v_from.status, 'ended_at', v_from.ended_at,
      -- end_run('completed') also leaves a run completed: only a submit (0018) is a delivery.
      'delivered', exists (select 1 from public.agent_activities where task_id = p_task_id and run_id = v_from.id
                            and type = 'response' and body->'submit' = 'true'::jsonb)) end,
    'pending_ops', v_pending, 'blocks', v_blocks, 'approvals', v_approvals, 'external_ops_open', v_external, 'counts', v_counts, 'summary', v_summary);
end $$;

-- The existing claim contract and guards, with an optional resume context.
drop function public.claim_task(uuid, text, text, int);
create function public.claim_task(p_task_id uuid default null, p_harness text default 'custom',
  p_external_session_id text default null, p_brief_version int default null, p_resume boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid; v_task public.agent_tasks%rowtype; v_run uuid; v_brief jsonb; v_ver int; v_resume jsonb;
begin
  v_agent := private.task_actor_agent_id();
  if v_agent is null then raise exception using errcode='PT403', message='agent_disabled'; end if;
  perform private.check_rate(v_agent);
  if p_resume and not coalesce((select a.capabilities->'resume' = 'true'::jsonb from public.agents a where a.id = v_agent), false) then
    raise exception using errcode = 'PT422', message = 'resume_unsupported';
  end if;

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

  update public.agent_approvals set run_id = v_run where task_id = v_task.id and status in ('pending','decided');
  update public.external_ops set run_id = v_run where task_id = v_task.id and status in ('pending','unknown');
  if private.task_waits_on_human(v_task.id) then
    update public.agent_runs set status = 'waiting' where id = v_run;
    update public.agent_tasks set state = 'input_required', waiting_on = 'human' where id = v_task.id;
  end if;

  perform set_config('app.run_id', v_run::text, true);
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_task.workspace_id, v_task.id, v_run, private.next_seq(v_task.id), 'action',
          jsonb_build_object('op','claim','harness',p_harness,'brief_version',v_ver), 'agent', v_agent);

  if p_resume then
    v_resume := private.resume_context(v_task.id, v_run);
    -- A handover is recorded only when the previous run ended with hand_over or a person released it after it started;
    -- the same agent claiming again after feedback is not one.
    if v_resume->'from' <> 'null'::jsonb and (
         exists (select 1 from public.agent_activities where task_id = v_task.id and type = 'checkpoint'
                  and run_id = (v_resume->'from'->>'run_id')::uuid and body->'handover' = 'true'::jsonb)
         or exists (select 1 from public.agent_activities p where p.task_id = v_task.id and p.type = 'prompt'
                  and p.body->'handover' = 'true'::jsonb
                  and p.seq > (select min(a.seq) from public.agent_activities a
                                where a.task_id = v_task.id and a.run_id = (v_resume->'from'->>'run_id')::uuid))) then
      insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
      values (v_task.workspace_id, v_task.id, v_run, private.next_seq(v_task.id), 'handover',
        jsonb_build_object('from_run_id', v_resume->'from'->'run_id', 'from_agent_id', v_resume->'from'->'agent_id',
          'from_harness', v_resume->'from'->'harness', 'to_run_id', v_run, 'to_agent_id', v_agent, 'to_harness', p_harness,
          'checkpoint_seq', v_resume->'checkpoint'->'seq', 'counts', v_resume->'counts', 'summary', v_resume->'summary'), 'agent', v_agent);
    end if;
  end if;

  select to_jsonb(b) into v_brief from public.task_briefs b where b.task_id=v_task.id and b.version=v_ver;
  return jsonb_build_object(
    'task_id', v_task.id, 'run_id', v_run, 'context_id', v_task.context_id,
    'row_page_id', v_task.row_page_id, 'brief', v_brief,
    'artifacts', (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.agent_artifacts a
                   where a.task_id=v_task.id and a.superseded_by is null),
    'recent_activities', (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
        select type, body, author_type, created_at from public.agent_activities
         where task_id=v_task.id and not ephemeral order by seq desc limit 20) x)) || case when p_resume then jsonb_build_object('resume', v_resume) else '{}'::jsonb end;
end $$;

create or replace function public.begin_external_op(p_run_id uuid, p_provider text, p_action text, p_params jsonb,
  p_approval_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_hash text; v_op public.external_ops%rowtype; v_approval uuid; v_auto uuid; v_ver int; v_res jsonb;
begin
  v_r := private.own_run(p_run_id);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if coalesce(p_provider, '') = '' or coalesce(p_action, '') = '' or jsonb_typeof(p_params) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'invalid_input';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_provider || '|' || p_action || '|' || p_params::text, 'utf8'), 'sha256'), 'hex');
  select * into v_op from public.external_ops
   where run_id = v_r.id and params_hash = v_hash and status in ('pending','unknown') order by created_at limit 1;
  if found then
    return jsonb_build_object('op_id', v_op.op_id, 'idempotency_key', v_op.idempotency_key, 'status', v_op.status);
  end if;

  if private.requires_approval(p_action, v_r.task_id) then
    if p_approval_receipt is null then
      select receipt into v_auto from public.agent_approvals
       where task_id = v_r.task_id and kind = 'action' and status = 'decided' and decision in ('approve','edit')
         and receipt is not null and receipt_expires_at > now()
         and action_hash = private.action_hash(p_action, v_r.task_id, null, p_params)
       order by decided_at desc limit 1;
      if v_auto is null then
        v_res := private.request_approval_core(v_r, p_action, p_params, null, 'Approve ' || p_action || ' via ' || p_provider || '?');
        return jsonb_build_object('status', 'approval_required', 'approval_id', v_res->'approval_id');
      end if;
      v_approval := private.consume_approval(v_auto, p_action, p_params, null, 'begin_external_op');
    end if;
    if p_approval_receipt is not null then
      select artifact_version into v_ver from public.agent_approvals where receipt = p_approval_receipt;
      v_approval := private.consume_approval(p_approval_receipt, p_action, p_params, v_ver, 'begin_external_op');
    end if;
  end if;

  insert into public.external_ops (workspace_id, task_id, run_id, provider, action, params_hash, params, idempotency_key, approval_id)
  values (v_r.workspace_id, v_r.task_id, v_r.id, p_provider, p_action, v_hash, p_params, gen_random_uuid()::text, v_approval)
  returning * into v_op;
  return jsonb_build_object('op_id', v_op.op_id, 'idempotency_key', v_op.idempotency_key, 'status', v_op.status);
end $$;

create or replace function public.create_agent(
  p_workspace_id uuid, p_created_by uuid, p_auth_user_id uuid, p_name text, p_kind text,
  p_role text default 'worker', p_sponsor_user_id uuid default null, p_capabilities jsonb default '{}'::jsonb,
  p_connection jsonb default '{}'::jsonb, p_monthly_budget_usd numeric default null, p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sponsor uuid := coalesce(p_sponsor_user_id, p_created_by); v_id uuid; v_bad text;
begin
  if not exists (
      select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = p_created_by and m.role in ('owner','editor'))
     and not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = p_created_by) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = v_sponsor)
     and not exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.owner_id = v_sponsor) then
    raise exception using errcode = 'PT422', message = 'sponsor_not_member';
  end if;
  if jsonb_typeof(p_capabilities) <> 'object' then raise exception using errcode = 'PT400', message = 'invalid_input'; end if;
  select key into v_bad from jsonb_each(p_capabilities)
   where key not in ('start','continue','cancel','events','approval','cost','files','resume') or jsonb_typeof(value) <> 'boolean' limit 1;
  if v_bad is not null then
    raise exception using errcode = 'PT400', message = 'invalid_input', detail = jsonb_build_object('capability', v_bad)::text;
  end if;
  insert into public.agents (id, workspace_id, auth_user_id, name, kind, role, sponsor_user_id, capabilities, connection, monthly_budget_usd, created_by)
  values (coalesce(p_id, gen_random_uuid()), p_workspace_id, p_auth_user_id, p_name, p_kind, coalesce(p_role, 'worker'), v_sponsor,
          coalesce(p_capabilities, '{}'::jsonb), coalesce(p_connection, '{}'::jsonb), p_monthly_budget_usd, p_created_by)
  returning id into v_id;
  perform private.audit(p_workspace_id, 'agent.create', jsonb_build_object('agent_id', v_id, 'created_by', p_created_by));
  return jsonb_build_object('agent_id', v_id);
end $$;

revoke execute on function private.checkpoint_v1(jsonb) from public;
revoke execute on function private.checkpoint_read(jsonb) from public;
revoke execute on function private.receipt_scope(text) from public;
revoke execute on function private.detach_task_links(uuid) from public;
revoke execute on function private.task_waits_on_human(uuid) from public;
revoke execute on function private.resume_context(uuid, uuid) from public;
revoke all on function public.save_checkpoint(uuid, jsonb, text) from public, anon;
revoke all on function public.hand_over(uuid, jsonb, text) from public, anon;
revoke all on function public.release_for_handover(uuid, uuid, text) from public, anon;
revoke all on function public.claim_task(uuid, text, text, int, boolean) from public, anon;
revoke all on function public.begin_external_op(uuid, text, text, jsonb, uuid) from public, anon;
revoke all on function public.create_agent(uuid, uuid, uuid, text, text, text, uuid, jsonb, jsonb, numeric, uuid) from public, anon, authenticated;
grant execute on function public.save_checkpoint(uuid, jsonb, text) to authenticated;
grant execute on function public.hand_over(uuid, jsonb, text) to authenticated;
grant execute on function public.release_for_handover(uuid, uuid, text) to authenticated;
grant execute on function public.claim_task(uuid, text, text, int, boolean) to authenticated;
grant execute on function public.begin_external_op(uuid, text, text, jsonb, uuid) to authenticated;

-- ============ review and revert (appended by a/revert-run) ============
