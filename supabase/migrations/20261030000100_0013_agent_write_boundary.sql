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
