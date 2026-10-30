-- Select before the global limit: unsubscribed people must not hold the queue.
-- At most 20 rows per person, 200 per pass, one round at a time. Random priority
-- per person prevents a fixed set of users winning every pass when >200 qualify.
-- A reminder more than 24 hours late stays available to the in-app checker.
-- Cover the id tie-break so LIMIT can stop the ordered scan for each person.
create index reminders_pending_push_idx on public.reminders (user_id, remind_at, id)
where not notified and deleted_at is null;

create function public.due_push_reminders()
returns table (id text, user_id uuid, page_id text, body text)
language sql volatile security definer set search_path = ''
as $$
  with people as materialized (
    select s.user_id, pg_catalog.random() as priority
    from (select distinct user_id from public.push_subscriptions) s
  )
  select r.id, p.user_id, r.page_id, r.body
  from people p
  cross join lateral (
    select r.id, r.page_id, r.body,
      row_number() over (order by r.remind_at, r.id) as position
    from public.reminders r
    where r.user_id = p.user_id and not r.notified and r.deleted_at is null
      and r.remind_at between now() - interval '24 hours' and now()
    order by r.remind_at, r.id
    limit 20
  ) r
  order by r.position, p.priority, p.user_id
  limit 200;
$$;
revoke all on function public.due_push_reminders() from public, anon, authenticated;
grant execute on function public.due_push_reminders() to service_role;

-- Agent notifications have independent pushed_at bookkeeping. Expire old rows
-- in bulk before selecting the fair batch, so backlogs cannot delay fresh pushes.
-- Keep 24 hours aligned with PUSH_TTL_MS in send-reminders/payload.ts.
create index notifications_pending_push_idx on public.notifications (user_id, created_at, id)
where pushed_at is null and kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested');

create function public.pending_push_notifications()
returns table (id uuid, user_id uuid, page_id text, task_id uuid, approval_id uuid,
  block_id text, kind text, payload jsonb, created_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update public.notifications n set pushed_at = now()
  where n.pushed_at is null and n.created_at < now() - interval '24 hours'
    and n.kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested');

  return query
  with people as materialized (
    select n.user_id, pg_catalog.random() as priority
    from (
      select distinct fresh.user_id from public.notifications fresh
      where fresh.pushed_at is null and fresh.created_at >= now() - interval '24 hours'
        and fresh.kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested')
    ) n
  )
  select n.id, p.user_id, n.page_id, n.task_id, n.approval_id,
    n.block_id, n.kind, n.payload, n.created_at
  from people p
  cross join lateral (
    select n.*, row_number() over (order by n.created_at, n.id) as position
    from public.notifications n
    where n.user_id = p.user_id and n.pushed_at is null
      and n.created_at >= now() - interval '24 hours'
      and n.kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested')
    order by n.created_at, n.id
    limit 20
  ) n
  order by n.position, p.priority, p.user_id
  limit 200;
end;
$$;
revoke all on function public.pending_push_notifications() from public, anon, authenticated;
grant execute on function public.pending_push_notifications() to service_role;

-- Free-text identifiers travel in the RPC body, never in PostgREST URL filters.
-- Count only state transitions, including when another pass already marked a row.
create function public.mark_reminders_pushed(p_ids text[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  marked integer;
begin
  update public.reminders set notified = true
  where id = any(p_ids) and not notified and deleted_at is null;
  get diagnostics marked = row_count;
  return marked;
end;
$$;
revoke all on function public.mark_reminders_pushed(text[]) from public, anon, authenticated;
grant execute on function public.mark_reminders_pushed(text[]) to service_role;

create function public.prune_push_subscriptions(p_endpoints text[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.push_subscriptions where endpoint = any(p_endpoints);
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.prune_push_subscriptions(text[]) from public, anon, authenticated;
grant execute on function public.prune_push_subscriptions(text[]) to service_role;
