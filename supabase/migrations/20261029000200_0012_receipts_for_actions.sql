-- 0012 · Receipts only for actions.
--
-- A receipt is what begin_external_op consumes to run an approved action once. 0011 let chat
-- sessions approve questions, plans and escalations; those decisions execute nothing, so they get
-- no receipt (defense in depth: nothing to leak into an `approval.decided` event or a chat reply).

create or replace function public.decide_approval(p_approval_id uuid, p_decision text, p_response jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a public.agent_approvals%rowtype; v_t public.agent_tasks%rowtype; v_receipt uuid; v_params jsonb;
begin
  if private.principal_type() <> 'human' then raise exception using errcode='PT403', message='humans_only'; end if;
  select * into v_a from public.agent_approvals where id = p_approval_id for update;
  if not found then raise exception using errcode='PT404', message='not_found'; end if;
  select * into v_t from public.agent_tasks where id = v_a.task_id;
  if not private.can_write_page(v_t.row_page_id, v_t.workspace_id) then raise exception using errcode='PT403', message='forbidden'; end if;
  if v_a.status <> 'pending' then raise exception using errcode='PT409', message='approval_not_pending'; end if;
  if v_a.expires_at < now() then update public.agent_approvals set status='expired' where id=v_a.id;
     raise exception using errcode='PT410', message='approval_expired'; end if;
  if not (p_decision = any (v_a.options)) then raise exception using errcode='PT422', message='decision_not_offered'; end if;
  -- Irreversible: a receipt that executes an action needs a session the workspace opened itself.
  if v_a.kind = 'action' and p_decision in ('approve','edit') and private.jwt_client_id() is not null then
    raise exception using errcode='PT403', message='direct_session_required';
  end if;

  v_params := v_a.params;
  if p_decision = 'edit' then v_params := coalesce(p_response->'params', v_a.params); end if;
  -- Only an approved action is executed later; a receipt for anything else would have no use.
  if v_a.kind = 'action' and p_decision in ('approve','edit') then v_receipt := gen_random_uuid(); end if;

  update public.agent_approvals
     set status='decided', decision=p_decision, response=p_response, decided_by=(select auth.uid()), decided_at=now(),
         params=v_params, action_hash=private.action_hash(action, task_id, artifact_version, v_params),
         receipt=v_receipt, receipt_expires_at = case when v_receipt is null then null else now() + interval '15 minutes' end
   where id = v_a.id;

  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_t.workspace_id, v_t.id, v_a.run_id, private.next_seq(v_t.id), 'prompt',
          jsonb_build_object('signal','feedback','source','row_panel','approval_id',v_a.id,'decision',p_decision,
                             'text', coalesce(p_response->>'text','')), 'human', (select auth.uid()));
  update public.agent_runs  set status='running' where id = v_a.run_id and status='waiting';
  update public.agent_tasks set state = case when active_run_id is not null then 'working' else 'queued' end, waiting_on=null
   where id = v_t.id and state='input_required';
  insert into public.agent_events (workspace_id, task_id, run_id, agent_id, type, payload, seq)
  select v_t.workspace_id, v_t.id, v_a.run_id, v_t.delegate_agent_id, 'approval.decided',
         jsonb_build_object('approval_id',v_a.id,'decision',p_decision,'receipt',v_receipt,'receipt_expires_at',now()+interval '15 minutes'),
         private.next_event_seq(v_t.id)
   where v_t.delegate_agent_id is not null;
  insert into public.audit_events (workspace_id, actor_id, actor_type, action, target)
  values (v_t.workspace_id, (select auth.uid()), 'human', 'approval.decide', jsonb_build_object('approval_id',v_a.id,'decision',p_decision));
  return jsonb_build_object('status','decided','receipt',v_receipt,'receipt_expires_at', now()+interval '15 minutes');
end $$;

revoke all on function public.decide_approval(uuid, text, jsonb) from public, anon;
grant execute on function public.decide_approval(uuid, text, jsonb) to authenticated;
