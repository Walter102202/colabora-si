-- Select before the global limit: unsubscribed people must not hold the queue.
-- At most 20 rows per person, 200 per pass, one round at a time. Random priority
-- per person prevents a fixed set of users winning every pass when >200 qualify.
-- A reminder more than 24 hours late stays available to the in-app checker.
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

-- Agent notifications have independent pushed_at bookkeeping. Include people
-- without subscriptions and old rows so the handler can still settle them;
-- apply the same fairness bound to both delivery and cleanup work.
create index notifications_pending_push_idx on public.notifications (user_id, created_at, id)
where pushed_at is null and kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested');

create function public.pending_push_notifications()
returns table (id uuid, user_id uuid, page_id text, task_id uuid, approval_id uuid,
  block_id text, kind text, payload jsonb, created_at timestamptz)
language sql volatile security definer set search_path = ''
as $$
  with people as materialized (
    select n.user_id, pg_catalog.random() as priority
    from (
      select distinct user_id from public.notifications
      where pushed_at is null and kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested')
    ) n
  )
  select n.id, p.user_id, n.page_id, n.task_id, n.approval_id,
    n.block_id, n.kind, n.payload, n.created_at
  from people p
  cross join lateral (
    select n.*, row_number() over (order by n.created_at, n.id) as position
    from public.notifications n
    where n.user_id = p.user_id and n.pushed_at is null
      and n.kind in ('input_required', 'ready_for_review', 'task_failed', 'approval_requested')
    order by n.created_at, n.id
    limit 20
  ) n
  order by n.position, p.priority, p.user_id
  limit 200;
$$;
revoke all on function public.pending_push_notifications() from public, anon, authenticated;
grant execute on function public.pending_push_notifications() to service_role;
