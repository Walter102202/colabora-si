-- Authorship is assigned at the shared write boundary for every brief-producing RPC.
create or replace function private.stamp_done_when(p_new jsonb, p_previous jsonb, p_by text)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(c || jsonb_build_object('by', coalesce(
    (select old->>'by' from jsonb_array_elements(coalesce(p_previous,'[]')) old
      where old->>'id'=c->>'id' and old->>'text'=c->>'text' limit 1),
    case when p_by in ('human','person') then 'person' else 'agent' end)) order by ord),'[]')
  from jsonb_array_elements(coalesce(p_new,'[]')) with ordinality items(c,ord);
$$;
revoke all on function private.stamp_done_when(jsonb,jsonb,text) from public,anon,authenticated;

-- Historical versions use their recorded author, not the migration principal.
update public.task_briefs set done_when=private.stamp_done_when(done_when,'[]',author_type);

create or replace function private.stamp_brief_criteria()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_previous jsonb;
begin
  select done_when into v_previous from public.task_briefs
    where task_id=new.task_id and version<new.version order by version desc limit 1;
  new.done_when := private.stamp_done_when(new.done_when,v_previous,
    coalesce(private.principal_type(),new.author_type));
  return new;
end $$;
revoke all on function private.stamp_brief_criteria() from public,anon,authenticated;
create trigger stamp_brief_criteria before insert on public.task_briefs
  for each row execute function private.stamp_brief_criteria();
