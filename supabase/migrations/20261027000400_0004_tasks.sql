-- 0004_tasks: the work model. Tasks, briefs, runs, activities (append-only), artifacts, approvals, reviews,
-- external operations, the dispatch outbox, audit log and model prices. State is written only by RPCs (0006)
-- and derived by triggers (0007); no table here has an INSERT/UPDATE/DELETE policy.
-- Depends on 0001_core (workspaces, pages, private helpers), 0002_agents and 0003 (notifications).

-- ============ tables ============

create table public.agent_tasks (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  context_id          uuid not null,
  db_page_id          text references public.pages(id) on delete set null,
  row_page_id         text not null references public.pages(id) on delete cascade,
  title               text not null default '',
  delegate_agent_id   uuid references public.agents(id) on delete set null,
  owner_user_id       uuid not null references auth.users(id),
  parent_task_id      uuid references public.agent_tasks(id) on delete cascade,
  reference_task_ids  uuid[] not null default '{}',
  depends_on_task_ids uuid[] not null default '{}',
  external_urls       jsonb not null default '[]'::jsonb,
  state               text not null default 'queued' check (state in
                        ('queued','working','input_required','ready_for_review','done','failed','cancelled')),
  review_state        text not null default 'none' check (review_state in
                        ('none','pending','approved','changes_requested','outdated')),
  acceptance          text not null default 'pending' check (acceptance in ('pending','accepted','rejected')),
  waiting_on          text check (waiting_on in ('human','lead','agent')),
  brief_version       int  not null default 0,
  brief_stale         boolean not null default false,
  active_run_id       uuid,
  review_rounds       int not null default 0,
  max_review_rounds   int not null default 2,
  cost_usd            numeric(12,6) not null default 0,
  last_activity_at    timestamptz,
  created_by          uuid not null,
  created_by_type     text not null default 'human' check (created_by_type in ('human','agent')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz,
  closed_by           uuid references auth.users(id)
);
create unique index agent_tasks_open_row_uidx on public.agent_tasks (row_page_id)
  where state not in ('done','failed','cancelled');
create index agent_tasks_ws_state_idx on public.agent_tasks (workspace_id, state, last_activity_at desc);
create index agent_tasks_delegate_idx on public.agent_tasks (delegate_agent_id, state) where delegate_agent_id is not null;
create index agent_tasks_parent_idx   on public.agent_tasks (parent_task_id) where parent_task_id is not null;

create table public.task_briefs (
  task_id        uuid not null references public.agent_tasks(id) on delete cascade,
  version        int  not null check (version >= 1),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  objective      text not null,
  constraints    text not null default '',
  done_when      jsonb not null default '[]'::jsonb,
  decisions      jsonb not null default '[]'::jsonb,
  sources        jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  next_step      text not null default '',
  policies       jsonb not null default '{}'::jsonb,
  author_id      uuid not null,
  author_type    text not null check (author_type in ('human','agent')),
  created_at     timestamptz not null default now(),
  primary key (task_id, version)
);

create table public.agent_runs (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  task_id             uuid not null references public.agent_tasks(id) on delete cascade,
  agent_id            uuid not null references public.agents(id),
  harness             text not null,
  external_session_id text,
  external_task_id    text,
  brief_version       int  not null,
  status              text not null default 'running' check (status in
                        ('running','waiting','completed','error','cancelled')),
  stop_requested_at   timestamptz,
  stop_acked_at       timestamptz,
  last_signal_at      timestamptz not null default now(),
  stale_at            timestamptz,
  waiting_on_task_id  uuid references public.agent_tasks(id),
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  model               text,
  cost_usd            numeric(12,6) not null default 0,
  cost_kind           text not null default 'unknown' check (cost_kind in ('measured','estimated','unknown')),
  error_message       text,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  created_at          timestamptz not null default now()
);
create index agent_runs_task_idx on public.agent_runs (task_id, started_at desc);
create unique index agent_runs_one_active_uidx on public.agent_runs (task_id) where status in ('running','waiting');
create index agent_runs_stale_scan_idx on public.agent_runs (last_signal_at)
  where status in ('running','waiting') and stale_at is null;
create index agent_runs_agent_idx on public.agent_runs (agent_id, started_at desc);
alter table public.agent_tasks add constraint agent_tasks_active_run_fk
  foreign key (active_run_id) references public.agent_runs(id) on delete set null;
alter table public.pages add constraint pages_last_edit_run_fk
  foreign key (last_edit_run_id) references public.agent_runs(id) on delete set null;

create table public.agent_activities (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  task_id         uuid not null references public.agent_tasks(id) on delete cascade,
  run_id          uuid references public.agent_runs(id) on delete set null,
  seq             bigint not null,
  type            text not null check (type in ('thought','action','elicitation','response','error','prompt')),
  body            jsonb not null,
  inverse_ops     jsonb,
  ephemeral       boolean not null default false,
  author_type     text not null check (author_type in ('human','agent','system')),
  author_id       uuid not null,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  unique (task_id, seq),
  unique (task_id, idempotency_key)
);
create index agent_activities_run_idx on public.agent_activities (run_id, seq);
revoke update, delete on public.agent_activities from public, anon, authenticated, service_role;

-- Append-only even for the table owner. Foreign-key actions (cascade delete of the task or workspace,
-- run_id set null when a run is removed) arrive nested inside the referential trigger and are allowed.
create or replace function private.agent_activities_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    if (to_jsonb(new) - 'run_id') = (to_jsonb(old) - 'run_id') then return new; end if;
  end if;
  raise exception using errcode = 'PT403', message = 'activities_immutable';
end $$;
revoke execute on function private.agent_activities_immutable() from public;
create trigger agent_activities_immutable before update or delete on public.agent_activities
  for each row execute function private.agent_activities_immutable();

create table public.agent_artifacts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  task_id       uuid not null references public.agent_tasks(id) on delete cascade,
  run_id        uuid references public.agent_runs(id) on delete set null,
  kind          text not null check (kind in ('page','file','diff','query','image','external')),
  ref           text not null,
  version       int  not null default 1,
  page_revision bigint,
  content_hash  text,
  title         text not null default '',
  satisfies     text[] not null default '{}',
  author_type   text not null check (author_type in ('human','agent')),
  author_id     uuid not null,
  superseded_by uuid references public.agent_artifacts(id),
  created_at    timestamptz not null default now()
);
create index agent_artifacts_task_idx on public.agent_artifacts (task_id, created_at desc);

create table public.agent_approvals (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  task_id            uuid not null references public.agent_tasks(id) on delete cascade,
  run_id             uuid references public.agent_runs(id) on delete set null,
  kind               text not null check (kind in ('action','elicitation','plan','escalation')),
  action             text,
  action_hash        text,
  params             jsonb not null default '{}'::jsonb,
  artifact_id        uuid references public.agent_artifacts(id),
  artifact_version   int,
  question           text not null default '',
  options            text[] not null default array['approve','reject']::text[]
                     check (options <@ array['approve','reject','edit','respond','ignore']::text[]),
  status             text not null default 'pending' check (status in ('pending','decided','consumed','expired','cancelled')),
  decision           text check (decision in ('approve','reject','edit','respond','ignore')),
  response           jsonb,
  receipt            uuid,
  receipt_expires_at timestamptz,
  consumed_at        timestamptz,
  consumed_by_op     text,
  requested_by_type  text not null check (requested_by_type in ('agent','system')),
  requested_by_id    uuid not null,
  decided_by         uuid references auth.users(id),
  decided_at         timestamptz,
  expires_at         timestamptz not null default now() + interval '7 days',
  created_at         timestamptz not null default now()
);
create index agent_approvals_pending_idx on public.agent_approvals (workspace_id, status) where status = 'pending';
create index agent_approvals_task_idx on public.agent_approvals (task_id);
create unique index agent_approvals_receipt_uidx on public.agent_approvals (receipt) where receipt is not null;

create table public.agent_reviews (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  task_id          uuid not null references public.agent_tasks(id) on delete cascade,
  run_id           uuid references public.agent_runs(id) on delete set null,
  reviewer_type    text not null check (reviewer_type in ('human','agent')),
  reviewer_id      uuid not null,
  artifact_id      uuid references public.agent_artifacts(id),
  artifact_version int  not null,
  brief_version    int  not null,
  verdict          text not null check (verdict in ('approved','changes_requested','blocked')),
  findings         jsonb not null default '[]'::jsonb,
  evidence         jsonb not null default '[]'::jsonb,
  outdated_by      text check (outdated_by in ('artifact','brief')),
  outdated_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index agent_reviews_task_idx on public.agent_reviews (task_id, created_at desc);

create table public.external_ops (
  op_id           uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  task_id         uuid not null references public.agent_tasks(id) on delete cascade,
  run_id          uuid references public.agent_runs(id) on delete set null,
  provider        text not null,
  action          text not null,
  params_hash     text not null,
  params          jsonb not null,
  idempotency_key text not null,
  status          text not null default 'pending' check (status in ('pending','done','unknown','failed')),
  provider_ref    text,
  approval_id     uuid references public.agent_approvals(id),
  attempts        int not null default 0,
  last_error      text,
  checked_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (run_id, idempotency_key)
);

create table public.agent_events (
  event_id     uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id      uuid not null references public.agent_tasks(id) on delete cascade,
  run_id       uuid references public.agent_runs(id) on delete set null,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  type         text not null check (type in ('task.start','task.continue','task.feedback','task.stop','approval.decided','brief.updated')),
  payload      jsonb not null,
  seq          bigint not null,
  attempt      int not null default 0,
  lease_until  timestamptz,
  status       text not null default 'queued' check (status in ('queued','leased','delivered','acked','failed','expired')),
  delivered_at timestamptz,
  acked_at     timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  unique (task_id, seq)
);
create index agent_events_pending_idx on public.agent_events (status, created_at) where status in ('queued','leased');
create index agent_events_agent_idx on public.agent_events (agent_id, created_at desc);

-- In-app inbox. 0003 normally creates it first; this keeps 0004 applicable on its own.
do $$
begin
  if to_regclass('public.notifications') is null then
    create table public.notifications (
      id          uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references public.workspaces(id) on delete cascade,
      user_id     uuid not null references auth.users(id) on delete cascade,
      kind        text not null check (kind in ('mention','comment_reply','share','invite','input_required','ready_for_review',
                                                'task_failed','approval_requested','approval_expired','escalation')),
      page_id     text,
      block_id    text,
      comment_id  text,
      task_id     uuid,
      approval_id uuid,
      actor_id    uuid,
      actor_type  text,
      payload     jsonb not null default '{}'::jsonb,
      read_at     timestamptz,
      pushed_at   timestamptz,
      emailed_at  timestamptz,
      created_at  timestamptz not null default now()
    );
    create index notifications_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
    alter table public.notifications enable row level security;
    create policy "own notifications select" on public.notifications for select to authenticated
      using ( user_id = (select auth.uid()) and private.principal_type() = 'human' );
    create policy "own notifications update" on public.notifications for update to authenticated
      using ( user_id = (select auth.uid()) and private.principal_type() = 'human' );
    create policy "own notifications delete" on public.notifications for delete to authenticated
      using ( user_id = (select auth.uid()) and private.principal_type() = 'human' );
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

create table public.audit_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  actor_id     uuid,
  actor_type   text not null check (actor_type in ('human','agent','system')),
  run_id       uuid,
  action       text not null,
  target       jsonb not null default '{}'::jsonb,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index audit_events_ws_idx on public.audit_events (workspace_id, created_at desc);
revoke update, delete on public.audit_events from public, anon, authenticated, service_role;

create table public.model_prices (
  model                     text primary key,
  input_usd_per_mtok        numeric not null,
  output_usd_per_mtok       numeric not null,
  cached_input_usd_per_mtok numeric,
  effective_from            date not null,
  source                    text
);

-- private.audit (0002) maps 'anon' to the principal; audit_events only admits human/agent/system.
create or replace function private.audit(p_workspace_id uuid, p_action text, p_target jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events (workspace_id, actor_id, actor_type, run_id, action, target)
  values (p_workspace_id, (select auth.uid()),
          case private.principal_type() when 'human' then 'human' when 'agent' then 'agent' else 'system' end,
          private.current_run_id(), p_action, coalesce(p_target, '{}'::jsonb));
end $$;
revoke execute on function private.audit(uuid, text, jsonb) from public;

-- ============ RLS helpers ============

-- Task visibility (§IV.4.2): human member or page share on the row; agent delegate or read grant on the row.
create or replace function private.can_see_task(p_ws uuid, p_row_page_id text, p_delegate uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case private.principal_type()
    when 'human' then private.is_human_member(p_ws) or private.has_page_share(p_row_page_id, array['view','comment','edit'])
    when 'agent' then (p_delegate is not null and p_delegate = private.current_agent_id()) or private.agent_can(p_row_page_id, 'read')
    else false end;
$$;

create or replace function private.can_read_task(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select private.can_see_task(t.workspace_id, t.row_page_id, t.delegate_agent_id)
                     from public.agent_tasks t where t.id = p_task_id), false);
$$;

create or replace function private.is_own_run(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_run_id is not null and exists (
    select 1 from public.agent_runs r where r.id = p_run_id and r.agent_id = private.current_agent_id());
$$;

create or replace function private.is_workspace_owner(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.principal_type() = 'human' and (
    exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = (select auth.uid()))
    or exists (select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id = (select auth.uid()) and m.role = 'owner'));
$$;

revoke execute on function private.can_see_task(uuid, text, uuid) from public;
revoke execute on function private.can_read_task(uuid) from public;
revoke execute on function private.is_own_run(uuid) from public;
revoke execute on function private.is_workspace_owner(uuid) from public;
grant execute on function private.can_see_task(uuid, text, uuid) to authenticated;
grant execute on function private.can_read_task(uuid) to authenticated;
grant execute on function private.is_own_run(uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid) to authenticated;

-- ============ RLS (§IV.4.2): SELECT only; every write goes through an RPC ============

alter table public.agent_tasks enable row level security;
alter table public.task_briefs enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_activities enable row level security;
alter table public.agent_artifacts enable row level security;
alter table public.agent_approvals enable row level security;
alter table public.agent_reviews enable row level security;
alter table public.external_ops enable row level security;
alter table public.agent_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.model_prices enable row level security;

create policy "task readers read tasks" on public.agent_tasks for select to authenticated
  using ( private.can_see_task(workspace_id, row_page_id, delegate_agent_id) );
create policy "task readers read briefs" on public.task_briefs for select to authenticated
  using ( private.can_read_task(task_id) );
create policy "task readers read runs" on public.agent_runs for select to authenticated
  using ( private.can_read_task(task_id) );
create policy "task readers or run owner read activities" on public.agent_activities for select to authenticated
  using ( private.can_read_task(task_id) or private.is_own_run(run_id) );
create policy "task readers read artifacts" on public.agent_artifacts for select to authenticated
  using ( private.can_read_task(task_id) );
create policy "members or run owner read approvals" on public.agent_approvals for select to authenticated
  using ( private.is_human_member(workspace_id) or private.is_own_run(run_id) );
create policy "task readers read reviews" on public.agent_reviews for select to authenticated
  using ( private.can_read_task(task_id) );
create policy "members or run owner read external ops" on public.external_ops for select to authenticated
  using ( private.is_human_member(workspace_id) or private.is_own_run(run_id) );
-- Editors read the outbox for debugging; the recipient agent reads its own events (Realtime channel agent-<id>).
create policy "editors or recipient read events" on public.agent_events for select to authenticated
  using ( private.is_human_editor(workspace_id) or (agent_id = private.current_agent_id()) );
create policy "owners read audit" on public.audit_events for select to authenticated
  using ( private.is_workspace_owner(workspace_id) );
create policy "authenticated read model prices" on public.model_prices for select to authenticated
  using ( true );

revoke insert, update, delete on public.model_prices from anon, authenticated;

-- ============ Realtime ============

alter publication supabase_realtime add table
  public.agent_tasks, public.agent_runs, public.agent_activities, public.agent_approvals,
  public.agent_reviews, public.agent_artifacts, public.agent_events;
