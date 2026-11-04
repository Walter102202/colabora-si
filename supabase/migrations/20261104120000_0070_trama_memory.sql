-- Private, person-owned memory. It is context, never decision authority.
create table public.person_memory_settings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  consolidated_through_seq bigint not null default 0,
  last_consolidated_at timestamptz,
  primary key (workspace_id,user_id)
);
create table public.person_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('preference','fact','commitment')),
  body text not null check (char_length(body) between 3 and 500),
  origin text not null check (origin in ('explicit','extracted')),
  source_message_id uuid not null references public.agent_messages(id) on delete cascade,
  source_quote text not null check (char_length(source_quote) between 3 and 500),
  status text not null default 'active' check (status in ('active','superseded')),
  superseded_by uuid references public.person_memories(id) on delete set null,
  expires_at timestamptz, last_used_at timestamptz, edited_at timestamptz,
  search_tsv tsvector,
  created_at timestamptz not null default now()
);
create index person_memories_owner_idx on public.person_memories(workspace_id,user_id,created_at desc);
create index person_memories_source_idx on public.person_memories(source_message_id);
create index person_memories_replaced_idx on public.person_memories(superseded_by);
create index person_memories_search_idx on public.person_memories using gin(search_tsv);
create table private.memory_forgotten_messages (
  message_id uuid primary key references public.agent_messages(id) on delete cascade
);
alter table public.person_memories enable row level security;
alter table public.person_memory_settings enable row level security;
alter table private.memory_forgotten_messages enable row level security;
revoke all on public.person_memories,public.person_memory_settings from public,anon,authenticated;
revoke all on private.memory_forgotten_messages from public,anon,authenticated;
grant select on public.person_memories,public.person_memory_settings to authenticated;
grant all on public.person_memories,public.person_memory_settings,private.memory_forgotten_messages to service_role;
create policy "own memory" on public.person_memories for select to authenticated using (
  user_id=(select auth.uid()) and private.principal_type()='human' and private.jwt_client_id() is null
  and private.is_human_member(workspace_id));
create policy "own memory settings" on public.person_memory_settings for select to authenticated using (
  user_id=(select auth.uid()) and private.principal_type()='human' and private.jwt_client_id() is null
  and private.is_human_member(workspace_id));

create or replace function private.memory_has_secret(p_text text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_text ~* '(://[^/?#[:space:]]*@|[?&;[:space:]]?(password|passwd|token|secret|api[_-]?key|authorization)[[:space:]]*[:=]|bearer[[:space:]]|-----begin.*private key|(^|[^a-z0-9])(agt_|sb_secret_|sk_live_)[a-z0-9_-]+|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.|[a-z0-9]{32,}|(^|[^0-9])([0-9][ -]?){13,16}([^0-9]|$))',false);
$$;
revoke all on function private.memory_has_secret(text) from public,anon,authenticated;

create or replace function private.memory_command(p_text text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_text text:=btrim(p_text); v_match text[]; v_rest text;
begin
  if v_text ~ E'[\r\n]' or v_text ~ '\?$' then return null; end if;
  v_match:=regexp_match(v_text,'^(remember( that)?|don''t forget( that)?|recuerda( que)?|recordá( que)?|acuérdate( de| que)?|no olvides( que)?)[[:space:]]+(.{3,})$','i');
  if v_match is not null then
    v_rest:=btrim(v_match[8]);
    if v_rest ~* '^(when|what|how|cuando|cuándo|qué|lo que)([[:space:]]|$)' then return null; end if;
    return jsonb_build_object('kind','remember','text',v_rest);
  end if;
  if lower(v_text) in ('forget it','olvídalo','never mind') then return null; end if;
  v_match:=regexp_match(v_text,'^(forget|olvida|olvídate)[[:space:]]+(.+)$','i');
  if v_match is null then return null; end if;
  v_rest:=btrim(v_match[2]);
  if lower(v_rest) in ('that','eso','what i said','lo que dije') then v_rest:=null;
  else v_rest:=regexp_replace(v_rest,'^(that|about|que|lo de|de)[[:space:]]+','','i'); end if;
  return jsonb_build_object('kind','forget','target',v_rest);
end $$;
revoke all on function private.memory_command(text) from public,anon,authenticated;

create or replace function private.person_memory_enabled(p_ws uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_workspace_member_user(p_ws,p_user) and coalesce((select enabled from public.person_memory_settings where workspace_id=p_ws and user_id=p_user),true);
$$;
revoke all on function private.person_memory_enabled(uuid,uuid) from public,anon,authenticated;

create or replace function private.maintain_person_memory()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if private.memory_has_secret(new.body) or private.memory_has_secret(new.source_quote)
    or not exists(select 1 from public.agent_messages m where m.id=new.source_message_id
      and m.workspace_id=new.workspace_id and m.user_id=new.user_id and m.direction='in'
      and m.kind<>'system' and not m.forwarded and not m.pasted and strpos(m.body,new.source_quote)>0
      and not exists(select 1 from private.memory_forgotten_messages f where f.message_id=m.id)) then
    raise exception using errcode='PT400',message='invalid_memory';
  end if;
  if new.superseded_by is not null and not exists(select 1 from public.person_memories m
    where m.id=new.superseded_by and m.workspace_id=new.workspace_id and m.user_id=new.user_id and m.id<>new.id) then
    raise exception using errcode='PT400',message='invalid_memory';
  end if;
  new.search_tsv:=to_tsvector('simple',extensions.unaccent('extensions.unaccent'::regdictionary,new.body));
  return new;
end $$;
revoke all on function private.maintain_person_memory() from public,anon,authenticated;
create trigger person_memory_validate before insert or update on public.person_memories
  for each row execute function private.maintain_person_memory();

-- Serialize saves, edits, forgetting and extraction through the same person row.
create or replace function private.lock_person_memory(p_ws uuid,p_user uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.person_memory_settings(workspace_id,user_id,consolidated_through_seq)
    select p_ws,p_user,coalesce(max(seq),0) from public.agent_messages where workspace_id=p_ws and user_id=p_user
    on conflict do nothing;
  perform 1 from public.person_memory_settings where workspace_id=p_ws and user_id=p_user for update;
end $$;
revoke all on function private.lock_person_memory(uuid,uuid) from public,anon,authenticated;

create or replace function private.memory_forget_core(p_memory public.person_memories)
returns void language plpgsql security definer set search_path='' as $$
declare v_ids uuid[];
begin
  perform private.lock_person_memory(p_memory.workspace_id,p_memory.user_id);
  with recursive chain(id) as (
    select p_memory.id
    union
    select m.id from public.person_memories m join chain c on
      (m.superseded_by=c.id or m.id=(select x.superseded_by from public.person_memories x where x.id=c.id))
      where m.workspace_id=p_memory.workspace_id and m.user_id=p_memory.user_id
  ) select array_agg(id) into v_ids from chain;
  insert into private.memory_forgotten_messages(message_id)
    select distinct source_message_id from public.person_memories where id=any(v_ids) on conflict do nothing;
  -- Remove persisted citations as well as the facts themselves.
  update public.agent_messages a set outcome=jsonb_set(a.outcome,'{memory_used}',
    (select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(a.outcome->'memory_used') x where not (x->>'id'=any(v_ids::text[]))))
    where a.workspace_id=p_memory.workspace_id and a.user_id=p_memory.user_id and jsonb_typeof(a.outcome->'memory_used')='array';
  delete from public.person_memories where id=any(v_ids);
end $$;
revoke all on function private.memory_forget_core(public.person_memories) from public,anon,authenticated;

create or replace function private.require_memory_person(p_ws uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if private.principal_type()<>'human' or auth.uid() is null then raise exception using errcode='PT403',message='humans_only'; end if;
  if private.jwt_client_id() is not null then raise exception using errcode='PT403',message='direct_session_required'; end if;
  if p_ws is null or not private.is_human_member(p_ws) then raise exception using errcode='PT403',message='forbidden'; end if;
  perform private.lock_person_memory(p_ws,auth.uid());
end $$;
revoke all on function private.require_memory_person(uuid) from public,anon,authenticated;

create or replace function public.update_person_memory(p_id uuid,p_body text)
returns public.person_memories language plpgsql security definer set search_path='' as $$
declare v_m public.person_memories;
begin
  select * into v_m from public.person_memories where id=p_id and user_id=auth.uid();
  perform private.require_memory_person(v_m.workspace_id);
  if char_length(btrim(p_body)) not between 3 and 500 or p_body is null or private.memory_has_secret(p_body) then
    raise exception using errcode='PT400',message='invalid_input'; end if;
  update public.person_memories set body=btrim(p_body),edited_at=now() where id=p_id returning * into v_m;
  return v_m;
end $$;
revoke all on function public.update_person_memory(uuid,text) from public,anon;
grant execute on function public.update_person_memory(uuid,text) to authenticated;

create or replace function public.forget_person_memory(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_m public.person_memories; v_before int; v_after int;
begin
  select * into v_m from public.person_memories where id=p_id and user_id=auth.uid();
  perform private.require_memory_person(v_m.workspace_id);
  select count(*) into v_before from public.person_memories where workspace_id=v_m.workspace_id and user_id=v_m.user_id;
  perform private.memory_forget_core(v_m);
  select count(*) into v_after from public.person_memories where workspace_id=v_m.workspace_id and user_id=v_m.user_id;
  return jsonb_build_object('forgotten',v_before-v_after);
end $$;
revoke all on function public.forget_person_memory(uuid) from public,anon;
grant execute on function public.forget_person_memory(uuid) to authenticated;

create or replace function public.forget_all_person_memories(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_m public.person_memories; v_count int;
begin
  perform private.require_memory_person(p_workspace_id);
  select count(*) into v_count from public.person_memories where workspace_id=p_workspace_id and user_id=auth.uid();
  for v_m in select * from public.person_memories where workspace_id=p_workspace_id and user_id=auth.uid() loop
    perform private.memory_forget_core(v_m);
  end loop;
  return jsonb_build_object('forgotten',v_count);
end $$;
revoke all on function public.forget_all_person_memories(uuid) from public,anon;
grant execute on function public.forget_all_person_memories(uuid) to authenticated;

create or replace function public.set_person_memory_enabled(p_workspace_id uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.require_memory_person(p_workspace_id);
  if p_enabled is null then raise exception using errcode='PT400',message='invalid_input'; end if;
  update public.person_memory_settings set enabled=p_enabled where workspace_id=p_workspace_id and user_id=auth.uid();
  return jsonb_build_object('enabled',p_enabled);
end $$;
revoke all on function public.set_person_memory_enabled(uuid,boolean) from public,anon;
grant execute on function public.set_person_memory_enabled(uuid,boolean) to authenticated;

create or replace function private.clear_departed_memory()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.person_memory_settings where workspace_id=old.workspace_id and user_id=old.user_id for update;
  delete from public.person_memories where workspace_id=old.workspace_id and user_id=old.user_id;
  delete from private.memory_forgotten_messages f using public.agent_messages m
    where f.message_id=m.id and m.workspace_id=old.workspace_id and m.user_id=old.user_id;
  delete from public.person_memory_settings where workspace_id=old.workspace_id and user_id=old.user_id;
  return old;
end $$;
revoke all on function private.clear_departed_memory() from public,anon,authenticated;
create trigger workspace_member_memory_cleanup after delete on public.workspace_members
  for each row execute function private.clear_departed_memory();

insert into public.person_memory_settings(workspace_id,user_id,consolidated_through_seq)
select m.workspace_id,m.user_id,max(m.seq) from public.agent_messages m
  join public.workspace_members w on w.workspace_id=m.workspace_id and w.user_id=m.user_id
  where not exists(select 1 from public.agents a where a.auth_user_id=m.user_id)
  group by m.workspace_id,m.user_id on conflict do nothing;

create or replace function private.handle_memory_command(p_msg public.agent_messages,p_cmd jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_m public.person_memories; v_ids uuid[]; v_reply text; v_out jsonb; v_text text:=p_cmd->>'text'; v_target text:=p_cmd->>'target';
begin
  perform private.lock_person_memory(p_msg.workspace_id,p_msg.user_id);
  update public.agent_messages set intent=p_cmd where id=p_msg.id;
  if p_cmd->>'kind'='remember' then
    if not private.person_memory_enabled(p_msg.workspace_id,p_msg.user_id) then
      v_reply:='Memory is paused. You can turn it on in Settings → Memory.';
    elsif private.memory_has_secret(v_text) then v_reply:='I don''t keep passwords or keys.';
    elsif char_length(v_text) not between 3 and 500 then v_reply:='Please keep a memory between 3 and 500 characters.';
    else
      insert into public.person_memories(workspace_id,user_id,kind,body,origin,source_message_id,source_quote)
        values(p_msg.workspace_id,p_msg.user_id,'fact',v_text,'explicit',p_msg.id,v_text) returning * into v_m;
      v_reply:='Got it, I''ll remember: '||v_text;
      v_out:=jsonb_build_object('kind','memory_saved','memory_id',v_m.id);
    end if;
  else
    if v_target is null then
      select array[id] into v_ids from public.person_memories where workspace_id=p_msg.workspace_id and user_id=p_msg.user_id
        and status='active' and created_at>now()-interval '1 hour' order by created_at desc,id limit 1;
    else
      select array_agg(id) into v_ids from public.person_memories where workspace_id=p_msg.workspace_id and user_id=p_msg.user_id
        and status='active' and search_tsv @@ websearch_to_tsquery('simple',extensions.unaccent('extensions.unaccent'::regdictionary,v_target));
    end if;
    if coalesce(cardinality(v_ids),0)=0 then v_reply:='I couldn''t find that. You can review everything in Settings → Memory.';
    elsif cardinality(v_ids)>1 then
      select 'Which one? '||string_agg(body,E'\n')||'. You can also remove it in Settings → Memory.' into v_reply
        from (select body from public.person_memories where id=any(v_ids) order by created_at desc,id limit 5) x;
    else
      select * into v_m from public.person_memories where id=v_ids[1];
      perform private.memory_forget_core(v_m);
      v_reply:='Forgot: '||v_m.body; v_out:=jsonb_build_object('kind','memory_forgotten','count',1);
    end if;
  end if;
  v_out:=coalesce(v_out,jsonb_build_object('kind','memory_unchanged'));
  perform private.say(p_msg,v_reply,v_out);
  update public.agent_messages set outcome=v_out where id=p_msg.id;
  return v_out;
end $$;
revoke all on function private.handle_memory_command(public.agent_messages,jsonb) from public,anon,authenticated;

create or replace function private.handle_person_message(p_msg public.agent_messages, p_context jsonb, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cmd jsonb; v_es boolean; v_note public.saved_notes%rowtype; v_outcome jsonb; v_target jsonb;
begin
  insert into public.person_memory_settings(workspace_id,user_id,consolidated_through_seq)
    values(p_msg.workspace_id,p_msg.user_id,p_msg.seq-1) on conflict do nothing;
  if not p_msg.forwarded and not p_msg.pasted then v_cmd := private.note_command(p_msg.body); end if;

  if v_cmd is null and not p_msg.forwarded and not p_msg.pasted then
    v_cmd := private.memory_command(p_msg.body);
    if v_cmd is not null then return private.handle_memory_command(p_msg,v_cmd); end if;
  end if;

  if v_cmd->>'kind' = 'undo' then
    v_es := v_cmd->>'lang' = 'es';
    update public.agent_messages set intent = v_cmd where id = p_msg.id;
    select * into v_note from public.saved_notes
     where workspace_id = p_msg.workspace_id and user_id = p_msg.user_id and undone_at is null and created_at > now() - interval '1 hour'
     order by created_at desc limit 1 for update;
    if v_note.id is null then
      v_outcome := jsonb_build_object('kind', 'nothing_to_undo');
      perform private.say(p_msg, case when v_es then 'No hay una nota reciente para deshacer.' else 'There is no recent note to undo.' end, v_outcome);
    else
      perform private.undo_note_core(v_note);
      v_outcome := jsonb_build_object('kind', 'note_undone', 'note_id', v_note.id, 'page_id', v_note.page_id);
      perform private.say(p_msg, case when v_es then 'Listo, quité esa nota.' else 'Done, I removed that note.' end, v_outcome);
    end if;
    update public.agent_messages set outcome = v_outcome where id = p_msg.id;
    return v_outcome;
  end if;

  if v_cmd->>'kind' = 'save' then
    v_target := case v_cmd->>'mode'
      when 'inline' then jsonb_build_object('text', v_cmd->>'text', 'source', jsonb_build_object('kind', case when p_msg.kind = 'voice' then 'voice' else 'message' end))
      when 'compound' then '{"compose":true}'::jsonb
      else private.note_target(p_msg, v_cmd, p_context) end;
    v_cmd := v_cmd || jsonb_strip_nulls(jsonb_build_object('resolved', v_target, 'tz', p_tz));
  end if;
  v_outcome := jsonb_build_object('kind', 'for_agent');
  update public.agent_messages set intent = v_cmd, needs_reply = true, outcome = v_outcome where id = p_msg.id;
  return v_outcome;
end $$;
revoke all on function private.handle_person_message(public.agent_messages, jsonb, text) from public, anon, authenticated;

