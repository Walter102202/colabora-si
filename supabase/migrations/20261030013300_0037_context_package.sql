-- 0037 · Context package: what an agent gets with a task, beyond the brief.
--
-- task_context(run) returns the lessons that apply to the task and the decisions in force in its project, each with the
-- reason it is there. It is a separate call, not part of claim_task: the claim keeps its row lock short, a failure here
-- never loses a run, and the claim_task chain stays free. The claim_task tool calls it right after the claim, adds the
-- related pages under the caller's RLS, and returns everything together.
--
-- A lesson reaches an agent for a task inside the lesson's scope, because a person accepted that text for that scope.
-- A decision follows the page grants: the task's own ancestors, whose decisions bind it, and tasks the agent can read.
-- The rest is counted in withheld, without its content.

create table public.lesson_deliveries (
  lesson_id    uuid not null references public.lessons(id) on delete cascade,
  run_id       uuid not null references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id      uuid not null references public.agent_tasks(id) on delete cascade,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  why          text not null,
  delivered_at timestamptz not null default now(),
  cited_at     timestamptz,
  cite_note    text check (char_length(cite_note) <= 500),
  primary key (lesson_id, run_id)
);
create index lesson_deliveries_task_idx on public.lesson_deliveries (task_id);
create index lesson_deliveries_ws_idx on public.lesson_deliveries (workspace_id, delivered_at desc);

alter table public.lesson_deliveries enable row level security;
revoke all on public.lesson_deliveries from anon, authenticated;
grant select on public.lesson_deliveries to authenticated;
grant all on public.lesson_deliveries to service_role;
create policy "members read lesson deliveries" on public.lesson_deliveries for select to authenticated
  using (private.is_human_member(workspace_id));

-- Words of five letters or more, normalized the way page search does it.
create or replace function private.lexemes(p_text text)
returns text[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(l order by l), '{}')
    from unnest(tsvector_to_array(to_tsvector('simple', extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p_text, ''))))) l
   where char_length(l) >= 5 and l ~ '[[:alpha:]]';
$$;

-- The five lessons that fit a task best: the narrowest scope first, then the ones that share words with the brief, then
-- the newest. The task's own lessons are left out: it already has the correction.
create or replace function private.task_lessons(p_t public.agent_tasks, p_agent uuid)
returns table (id uuid, body text, example text, scope text, why text, source_task_id uuid, accepted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with brief as (
    select private.lexemes(b.objective || ' ' || b.constraints || ' ' || p_t.title || ' ' ||
             coalesce((select string_agg(c->>'text', ' ') from jsonb_array_elements(b.done_when) c), '')) as words
      from public.task_briefs b where b.task_id = p_t.id and b.version = p_t.brief_version
  ), chain as (
    select private.page_chain(p_t.row_page_id) as ids
  ), ranked as (
    select l.*, array(select unnest(private.lexemes(l.body || ' ' || l.example)) intersect select unnest((select words from brief)) order by 1) as shared,
           case l.scope when 'context' then 0 when 'page' then 1 else 2 end as breadth,
           array_position((select ids from chain), l.scope_page_id) as depth
      from public.lessons l
     where l.workspace_id = p_t.workspace_id and l.status = 'accepted' and l.source_task_id is distinct from p_t.id
       and private.lesson_applies(l, p_t, (select ids from chain))
       and (l.scope <> 'page' or exists (select 1 from public.pages p where p.id = l.scope_page_id and p.deleted_at is null))
  )
  select r.id, r.body, r.example, r.scope,
         case r.scope
           when 'context' then 'Accepted for this project'
           when 'workspace' then 'Accepted for the whole workspace'
           else coalesce((select format('Accepted for "%s", which holds this task', coalesce(nullif(p.title, ''), 'Untitled'))
                            from public.pages p where p.id = r.scope_page_id and private.agent_has_grant(p_agent, p.id, 'read')),
                         'Accepted for a page that holds this task') end
         || case when cardinality(r.shared) > 0 then '; shares with your brief: ' || array_to_string(r.shared[1:5], ', ') else '' end,
         r.source_task_id, r.decided_at
    from ranked r
   order by r.breadth, r.depth nulls last, cardinality(r.shared) desc, r.decided_at desc
   limit 5;
$$;

-- The decisions in force around a task: what the briefs of its project record and what people answered there. A task
-- that failed or was cancelled decides nothing any more, and the task's own decisions are already in its brief.
create or replace function private.task_decisions(p_t public.agent_tasks, p_agent uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_above uuid[]; v_items jsonb; v_withheld int;
begin
  with recursive up as (
    select p.id, p.parent_task_id, 1 as depth from public.agent_tasks p where p.id = p_t.parent_task_id
    union all
    select p.id, p.parent_task_id, u.depth + 1 from up u join public.agent_tasks p on p.id = u.parent_task_id where u.depth < 16
  ) select coalesce(array_agg(id), '{}') into v_above from up;

  with around as (
    select t.*, t.id = any (v_above) as above,
           t.id = any (v_above) or t.delegate_agent_id = p_agent or private.agent_has_grant(p_agent, t.row_page_id, 'read') as visible
      from public.agent_tasks t
     where t.context_id = p_t.context_id and t.id <> p_t.id and t.request_kind is null and t.state not in ('failed','cancelled')
  ), items as (
    select a.id as task_id, a.title, a.above, a.visible, left(d->>'text', 300) as body, nullif(d->>'at', '')::timestamptz as at, coalesce(d->>'by', '') as who
      from around a join public.task_briefs b on b.task_id = a.id and b.version = a.brief_version,
           jsonb_array_elements(b.decisions) d
     where coalesce(btrim(d->>'text'), '') <> ''
    union all
    select a.id, a.title, a.above, a.visible, left(q.question, 150) || ': ' || left(q.response->>'text', 150), q.decided_at, 'a person'
      from around a join public.agent_approvals q on q.task_id = a.id
     where q.kind in ('elicitation','plan','escalation') and q.status in ('decided','consumed') and q.decided_by is not null
       and coalesce(btrim(q.response->>'text'), '') <> ''
  )
  select (select coalesce(jsonb_agg(jsonb_build_object('task_id', i.task_id, 'text', i.body, 'at', i.at, 'by', i.who,
            'why', case when i.above then format('Decided on "%s", above your task', left(i.title, 80))
                        else format('Decided on "%s", in this project', left(i.title, 80)) end) order by i.above desc, i.at desc nulls last), '[]'::jsonb)
            from (select * from items where visible order by above desc, at desc nulls last limit 8) i),
         (select count(*) from items where not visible)
    into v_items, v_withheld;
  return jsonb_build_object('decisions', v_items, 'withheld', jsonb_build_object('decisions', v_withheld));
end $$;

-- For the agent of a run, on its own run. Every delivered lesson leaves a row, which is what cite_lesson and the
-- numbers of lesson_stats read. A request task gets nothing: it is the platform agent working on its own input.
create or replace function public.task_context(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_t public.agent_tasks%rowtype; v_lessons jsonb; v_rest jsonb; v_n int; v_d int;
begin
  v_r := private.own_run(p_run_id, false);
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  select * into v_t from public.agent_tasks where id = v_r.task_id;
  if v_t.request_kind is not null then
    return jsonb_build_object('lessons', '[]'::jsonb, 'decisions', '[]'::jsonb, 'withheld', jsonb_build_object('decisions', 0));
  end if;
  with delivered as (
    select * from private.task_lessons(v_t, v_r.agent_id)
  ), saved as (
    insert into public.lesson_deliveries (lesson_id, run_id, workspace_id, task_id, agent_id, why)
    select d.id, v_r.id, v_t.workspace_id, v_t.id, v_r.agent_id, d.why from delivered d
    on conflict (lesson_id, run_id) do nothing
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'text', d.body, 'example', nullif(d.example, ''), 'scope', d.scope,
           'why', d.why, 'accepted_at', d.accepted_at)), '[]'::jsonb), count(*)
    into v_lessons, v_n from delivered d;
  v_rest := private.task_decisions(v_t, v_r.agent_id);
  v_d := jsonb_array_length(v_rest->'decisions');
  if v_n + v_d > 0 then
    insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id, idempotency_key)
    values (v_t.workspace_id, v_t.id, v_r.id, private.next_seq(v_t.id), 'action',
            jsonb_build_object('op', 'context_package', 'lessons', v_n, 'decisions', v_d,
              'lesson_ids', (select coalesce(jsonb_agg(l->'id'), '[]'::jsonb) from jsonb_array_elements(v_lessons) l),
              'summary', format('Received %s lesson(s) and %s decision(s) with the task', v_n, v_d)),
            'agent', v_r.agent_id, 'context:' || v_r.id::text)
    on conflict (task_id, idempotency_key) do nothing;
  end if;
  return jsonb_build_object('lessons', v_lessons) || v_rest;
end $$;

-- The agent says a delivered lesson changed what it did: a line in the task's history and a mark on the delivery.
create or replace function public.cite_lesson(p_run_id uuid, p_lesson_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_note text := nullif(btrim(left(coalesce(p_note, ''), 500)), ''); v_body text;
begin
  v_r := private.own_run(p_run_id);
  if v_r.stop_requested_at is not null then raise exception using errcode = 'PT409', message = 'stop_requested'; end if;
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  update public.lesson_deliveries set cited_at = coalesce(cited_at, now()), cite_note = coalesce(v_note, cite_note)
   where lesson_id = p_lesson_id and run_id = v_r.id;
  if not found then raise exception using errcode = 'PT422', message = 'lesson_not_delivered'; end if;
  select body into v_body from public.lessons where id = p_lesson_id;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id, idempotency_key)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), 'action',
          jsonb_build_object('op', 'cite_lesson', 'lesson_id', p_lesson_id, 'note', v_note, 'summary', 'Applied a lesson: ' || left(v_body, 120)),
          'agent', v_r.agent_id, 'cite:' || v_r.id::text || ':' || p_lesson_id::text)
  on conflict (task_id, idempotency_key) do nothing;
  return jsonb_build_object('cited', true);
end $$;

-- What each lesson did: how often it was delivered and cited, how many of those tasks were corrected afterwards, and the
-- tasks of its scope accepted at the first delivery, before the lesson and with it. The two rates are the experiment.
create or replace function public.lesson_stats(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_human_member(p_workspace_id) then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  return (
    with closed as (
      select t as task, t.id, t.closed_at, private.page_chain(t.row_page_id) as chain,
             t.acceptance = 'accepted' and t.review_rounds = 0 as first_pass
        from public.agent_tasks t
       where t.workspace_id = p_workspace_id and t.state = 'done' and t.request_kind is null
         and not exists (select 1 from public.task_briefs b where b.task_id = t.id and b.version = t.brief_version and b.policies ? 'review_of')
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'lesson_id', l.id,
      'delivered', (select count(*) from public.lesson_deliveries d where d.lesson_id = l.id),
      'cited', (select count(*) from public.lesson_deliveries d where d.lesson_id = l.id and d.cited_at is not null),
      'corrected_after', (select count(distinct d.task_id) from public.lesson_deliveries d
                           where d.lesson_id = l.id and exists (select 1 from public.agent_reviews r
                                 where r.task_id = d.task_id and r.verdict = 'changes_requested' and r.created_at > d.delivered_at)),
      'before', (select jsonb_build_object('tasks', count(*), 'first_pass', count(*) filter (where c.first_pass))
                   from closed c where c.closed_at < l.decided_at and c.id is distinct from l.source_task_id
                     and private.lesson_applies(l, c.task, c.chain)),
      'after', (select jsonb_build_object('tasks', count(*), 'first_pass', count(*) filter (where c.first_pass))
                  from closed c where exists (select 1 from public.lesson_deliveries d where d.lesson_id = l.id and d.task_id = c.id))
    )), '[]'::jsonb)
    from public.lessons l
   where l.workspace_id = p_workspace_id and l.status in ('accepted','superseded','retired') and l.decided_at is not null);
end $$;

revoke all on function private.lexemes(text) from public;
revoke all on function private.task_lessons(public.agent_tasks, uuid) from public;
revoke all on function private.task_decisions(public.agent_tasks, uuid) from public;
revoke all on function public.task_context(uuid) from public, anon;
revoke all on function public.cite_lesson(uuid, uuid, text) from public, anon;
revoke all on function public.lesson_stats(uuid) from public, anon;
grant execute on function public.task_context(uuid) to authenticated;
grant execute on function public.cite_lesson(uuid, uuid, text) to authenticated;
grant execute on function public.lesson_stats(uuid) to authenticated;
