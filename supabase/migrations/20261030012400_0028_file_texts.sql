-- read_file: the text of a file attached to a page, extracted once by the workspace's platform agent with its
-- model and kept for every reader. A reader is whoever can read a page that holds the file: the same rule as the
-- storage policy "page readers read files" (0001), so the text never reaches someone the file would not.

create table public.file_texts (
  file_id      text primary key references public.files(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status       text not null check (status in ('ready','partial','unsupported','failed')),
  mime         text,
  pages        jsonb not null default '[]'::jsonb,
  total_pages  int,
  chars        int not null default 0,
  model        text,
  cost_usd     numeric(12,6),
  error        text,
  extracted_by uuid references public.agents(id) on delete set null,
  run_id       uuid references public.agent_runs(id) on delete set null,
  updated_at   timestamptz not null default now()
);
alter table public.file_texts enable row level security;
revoke all on public.file_texts from anon, authenticated;
grant select on public.file_texts to authenticated;
grant all on public.file_texts to service_role;
create policy "page readers read file texts" on public.file_texts for select to authenticated using (
  exists (select 1 from public.page_files pf join public.pages p on p.id = pf.page_id
           where pf.file_id = file_texts.file_id and p.workspace_id = file_texts.workspace_id
             and p.deleted_at is null and p.data is not null and private.can_read_page(p.id, p.workspace_id)));

-- The platform agent saves what it extracted, from a run of its own and for a file on a page it can read.
-- p_pages: [{page, text}] in reading order. One action activity on the run says what was read and with which model.
create or replace function public.save_file_text(p_run_id uuid, p_page_id text, p_file_id text, p_status text, p_pages jsonb,
  p_total_pages int default null, p_mime text default null, p_model text default null, p_cost_usd numeric default null,
  p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_runs%rowtype; v_ws uuid; v_chars int; v_name text;
begin
  v_r := private.own_run(p_run_id);
  if v_r.stop_requested_at is not null then raise exception using errcode = 'PT409', message = 'stop_requested'; end if;
  if v_r.status not in ('running','waiting') then raise exception using errcode = 'PT422', message = 'run_not_active'; end if;
  if not exists (select 1 from public.agents where id = v_r.agent_id and is_platform) then
    raise exception using errcode = 'PT403', message = 'platform_only';
  end if;
  select f.workspace_id into v_ws from public.files f
   where f.id = p_file_id and f.workspace_id = v_r.workspace_id
     and exists (select 1 from public.page_files pf join public.pages p on p.id = pf.page_id
                  where pf.page_id = p_page_id and pf.file_id = f.id and p.deleted_at is null
                    and private.can_read_page(p.id, p.workspace_id));
  if v_ws is null then raise exception using errcode = 'PT404', message = 'not_found'; end if;
  if p_status is null or p_status not in ('ready','partial','unsupported','failed')
     or jsonb_typeof(p_pages) is distinct from 'array' or jsonb_array_length(p_pages) > 500
     or exists (select 1 from jsonb_array_elements(p_pages) x
                 where jsonb_typeof(x) is distinct from 'object'
                    or jsonb_typeof(x->'text') is distinct from 'string'
                    or case when jsonb_typeof(x->'page') = 'number' then
                         (x->>'page')::numeric < 1 or (x->>'page')::numeric > 2147483647
                         or (x->>'page')::numeric <> trunc((x->>'page')::numeric)
                       else true end) then
    raise exception using errcode = 'PT400', message = 'invalid_input',
      detail = 'status is ready, partial, unsupported or failed; pages is at most 500 items {page, text}';
  end if;
  select coalesce(sum(length(x->>'text')), 0) into v_chars from jsonb_array_elements(p_pages) x;
  if v_chars > 2000000 then raise exception using errcode = 'PT400', message = 'invalid_input', detail = 'the text is longer than 2000000 characters'; end if;
  insert into public.file_texts (file_id, workspace_id, status, mime, pages, total_pages, chars, model, cost_usd, error, extracted_by, run_id, updated_at)
  values (p_file_id, v_ws, p_status, p_mime, p_pages, p_total_pages, v_chars, p_model, p_cost_usd, left(p_error, 500), v_r.agent_id, v_r.id, now())
  on conflict (file_id) do update set status = excluded.status, mime = excluded.mime, pages = excluded.pages,
    total_pages = excluded.total_pages, chars = excluded.chars, model = excluded.model, cost_usd = excluded.cost_usd,
    error = excluded.error, extracted_by = excluded.extracted_by, run_id = excluded.run_id, updated_at = now();
  select coalesce(b->>'fileName', p_file_id) into v_name
    from public.pages p, jsonb_path_query(p.data, '$.**') b
   where p.id = p_page_id and jsonb_typeof(b) = 'object' and b->>'fileId' = p_file_id limit 1;
  insert into public.agent_activities (workspace_id, task_id, run_id, seq, type, body, author_type, author_id)
  values (v_r.workspace_id, v_r.task_id, v_r.id, private.next_seq(v_r.task_id), 'action',
    jsonb_build_object('op', 'read_file', 'page_id', p_page_id, 'file_id', p_file_id, 'status', p_status,
      'pages', jsonb_array_length(p_pages), 'model', p_model, 'cost_usd', p_cost_usd,
      'summary', format('Read %s: %s page(s) with %s', coalesce(v_name, p_file_id), jsonb_array_length(p_pages), coalesce(p_model, 'the model'))),
    'agent', v_r.agent_id);
  return jsonb_build_object('status', p_status, 'chars', v_chars);
end $$;
revoke all on function public.save_file_text(uuid, text, text, text, jsonb, int, text, text, numeric, text) from public, anon;
grant execute on function public.save_file_text(uuid, text, text, text, jsonb, int, text, text, numeric, text) to authenticated;
