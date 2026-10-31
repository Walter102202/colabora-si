-- Server-owned notices and decisions. No channel decision capability is granted to authenticated callers.
create table public.channel_notices (
  id uuid primary key default gen_random_uuid(), link_id uuid not null references public.agent_channel_links(id),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  approval_id uuid references public.agent_approvals(id) on delete cascade,
  dedupe_key text not null unique, status text not null default 'pending' check(status in ('pending','sent','failed')),
  attempts int not null default 0, next_attempt_at timestamptz not null default now(),
  lease_until timestamptz, lease_token uuid, message_id bigint,
  answer_text text, answer_nonce text, answer_message_id bigint,
  channel_result jsonb, created_at timestamptz not null default now()
);
create index channel_notices_pending on public.channel_notices(next_attempt_at) where status='pending';
create index channel_notices_message on public.channel_notices(link_id,message_id);
alter table public.channel_notices enable row level security;
revoke all on public.channel_notices from anon,authenticated;
grant all on public.channel_notices to service_role;

create or replace function private.queue_channel_notice()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_task public.agent_tasks%rowtype; v_approval uuid; v_key text;
begin
  begin
    if tg_table_name='agent_approvals' then
      if new.status<>'pending' then return null; end if;
      select * into v_task from public.agent_tasks where id=new.task_id;
      v_approval:=new.id; v_key:='approval:'||new.id::text;
    else
      if new.state<>'ready_for_review' or old.state='ready_for_review' then return null; end if;
      v_task:=new; v_key:='delivery:'||new.id::text||':'||new.updated_at::text;
    end if;
    insert into public.channel_notices(link_id,task_id,approval_id,dedupe_key)
    select l.id,v_task.id,v_approval,v_key||':'||l.id::text from public.agent_channel_links l
    where l.workspace_id=v_task.workspace_id and l.user_id=v_task.owner_user_id and l.channel='telegram' and l.revoked_at is null
      and private.is_workspace_member_user(l.workspace_id,l.user_id)
    on conflict(dedupe_key) do nothing;
  exception when others then
    -- A channel outage must never roll back a task or its in-app notification.
    null;
  end;
  return null;
end $$;
revoke all on function private.queue_channel_notice() from public,anon,authenticated;
create trigger approvals_channel_notice after insert on public.agent_approvals for each row execute function private.queue_channel_notice();
create trigger tasks_channel_notice after update of state on public.agent_tasks for each row execute function private.queue_channel_notice();

create or replace function public.lease_channel_notices()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_ids uuid[]; v_items jsonb;
begin
  select array_agg(id) into v_ids from (
    select n.id from public.channel_notices n join public.agent_channel_links l on l.id=n.link_id
      join public.agent_tasks t on t.id=n.task_id left join public.agent_approvals a on a.id=n.approval_id
    where n.status='pending' and n.attempts<5 and n.next_attempt_at<=now() and (n.lease_until is null or n.lease_until<now())
      and l.revoked_at is null and private.is_workspace_member_user(l.workspace_id,l.user_id)
      and private.person_reads_page(t.row_page_id,t.workspace_id,l.user_id) and t.owner_user_id=l.user_id
      and ((n.approval_id is not null and a.status='pending' and a.expires_at>now()) or (n.approval_id is null and t.state='ready_for_review'))
    order by n.created_at for update of n skip locked limit 5) q;
  update public.channel_notices set attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() where id=any(v_ids);
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'lease',n.lease_token,'chat_id',l.chat_id,'task_id',t.id,'page_id',t.row_page_id,
    'agent',ag.name,'title',t.title,'approval',case when a.id is not null then jsonb_build_object('kind',a.kind,'action',a.action,'params',a.params,'question',a.question,'options',a.options) end)),'[]')
    into v_items from public.channel_notices n join public.agent_channel_links l on l.id=n.link_id
    join public.agent_tasks t on t.id=n.task_id left join public.agents ag on ag.id=t.delegate_agent_id
    left join public.agent_approvals a on a.id=n.approval_id where n.id=any(v_ids);
  return v_items;
end $$;
revoke all on function public.lease_channel_notices() from public,anon,authenticated;
grant execute on function public.lease_channel_notices() to service_role;

create or replace function public.complete_channel_notice(p_id uuid,p_lease uuid,p_message_id bigint default null,p_retryable boolean default true)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.channel_notices set message_id=p_message_id,
    status=case when p_message_id is not null then 'sent' when attempts>=5 or not p_retryable then 'failed' else 'pending' end,
    next_attempt_at=now()+interval '10 seconds'*power(2,least(attempts,5)),lease_until=null
  where id=p_id and lease_token=p_lease and status='pending';
end $$;
revoke all on function public.complete_channel_notice(uuid,uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function public.complete_channel_notice(uuid,uuid,bigint,boolean) to service_role;

create or replace function public.channel_pending(p_chat_id text,p_from_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.agent_channel_links%rowtype; v_count int;
begin
  v:=private.verified_channel_link(p_chat_id,p_from_id);
  insert into public.channel_notices(link_id,task_id,approval_id,dedupe_key)
    select v.id,t.id,a.id,'approval:'||a.id::text||':'||v.id::text
    from public.agent_approvals a join public.agent_tasks t on t.id=a.task_id
    where t.workspace_id=v.workspace_id and t.owner_user_id=v.user_id and a.status='pending' and a.expires_at>now()
      and private.person_reads_page(t.row_page_id,t.workspace_id,v.user_id)
    on conflict(dedupe_key) do nothing;
  insert into public.channel_notices(link_id,task_id,dedupe_key)
    select v.id,t.id,'delivery:'||t.id::text||':'||t.updated_at::text||':'||v.id::text
    from public.agent_tasks t where t.workspace_id=v.workspace_id and t.owner_user_id=v.user_id and t.state='ready_for_review'
      and private.person_reads_page(t.row_page_id,t.workspace_id,v.user_id)
    on conflict(dedupe_key) do nothing;
  update public.channel_notices n set status='pending',attempts=0,next_attempt_at=now(),lease_until=null,lease_token=null
  from public.agent_tasks t where n.link_id=v.id and n.task_id=t.id and t.owner_user_id=v.user_id
    and (n.lease_until is null or n.lease_until<now()) and private.person_reads_page(t.row_page_id,t.workspace_id,v.user_id)
    and ((n.approval_id is null and t.state='ready_for_review') or exists(select 1 from public.agent_approvals a where a.id=n.approval_id and a.status='pending' and a.expires_at>now()));
  get diagnostics v_count=row_count;
  return jsonb_build_object('pending',v_count);
end $$;
revoke all on function public.channel_pending(text,text) from public,anon,authenticated;
grant execute on function public.channel_pending(text,text) to service_role;

create or replace function public.channel_work_status(p_chat_id text,p_from_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v public.agent_channel_links%rowtype;
begin
  v:=private.verified_channel_link(p_chat_id,p_from_id);
  return jsonb_build_object('running_work',private.person_running_work(v.workspace_id,v.user_id));
end $$;
revoke all on function public.channel_work_status(text,text) from public,anon,authenticated;
grant execute on function public.channel_work_status(text,text) to service_role;

-- Text is a draft, never a decision. Telegram cannot distinguish clipboard pastes from typed text.
create or replace function public.channel_answer(p_chat_id text,p_from_id text,p_message_id bigint,p_text text,p_forwarded boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.agent_channel_links%rowtype; n public.channel_notices%rowtype; a public.agent_approvals%rowtype; nonce text;
begin
  v:=private.verified_channel_link(p_chat_id,p_from_id);
  if p_forwarded or p_text is null or length(btrim(p_text)) not between 1 and 3000 then raise exception using errcode='PT403',message='invalid_answer'; end if;
  select * into n from public.channel_notices where link_id=v.id and message_id=p_message_id;
  select * into a from public.agent_approvals where id=n.approval_id;
  if n.id is null or a.status is distinct from 'pending' or a.expires_at<=now() or a.kind='action' or a.action='payment' or not ('respond'=any(a.options))
    then raise exception using errcode='PT403',message='answer_not_available'; end if;
  nonce:=encode(extensions.gen_random_bytes(6),'hex');
  update public.channel_notices set answer_text=btrim(p_text),answer_nonce=nonce,answer_message_id=null where id=n.id;
  return jsonb_build_object('id',n.id,'nonce',nonce,'text',btrim(p_text));
end $$;
revoke all on function public.channel_answer(text,text,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.channel_answer(text,text,bigint,text,boolean) to service_role;

create or replace function public.channel_answer_sent(p_id uuid,p_nonce text,p_message_id bigint)
returns void language sql security definer set search_path='' as $$
  update public.channel_notices set answer_message_id=p_message_id where id=p_id and answer_nonce=p_nonce;
$$;
revoke all on function public.channel_answer_sent(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.channel_answer_sent(uuid,text,bigint) to service_role;

create or replace function public.channel_decide(p_chat_id text,p_from_id text,p_message_id bigint,p_callback text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.agent_channel_links%rowtype; n public.channel_notices%rowtype; a public.agent_approvals%rowtype; t public.agent_tasks%rowtype;
  v_parts text[]:=string_to_array(p_callback,':'); v_decision text; v_response jsonb; v_result jsonb;
  v_claims text:=current_setting('request.jwt.claims',true); v_sub text:=current_setting('request.jwt.claim.sub',true); v_role text:=current_setting('request.jwt.claim.role',true);
begin
  l:=private.verified_channel_link(p_chat_id,p_from_id);
  perform 1 from public.agent_channel_links where id=l.id and revoked_at is null for share;
  if not found then raise exception using errcode='PT403',message='not_linked'; end if;
  if p_message_id is null or p_message_id<=0 or p_callback is null or length(p_callback)>64 or v_parts[1] !~ '^[0-9a-f-]{36}$' then raise exception using errcode='PT400',message='invalid_callback'; end if;
  select * into n from public.channel_notices where id=v_parts[1]::uuid and link_id=l.id;
  if n.id is null or n.approval_id is null then raise exception using errcode='PT403',message='not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(n.approval_id::text||':channel-decision',0));
  select * into n from public.channel_notices where id=n.id;
  select * into a from public.agent_approvals where id=n.approval_id;
  select * into t from public.agent_tasks where id=n.task_id;
  if t.owner_user_id is distinct from l.user_id or t.workspace_id<>l.workspace_id or a.action='payment' or v_parts[2]='edit'
    then raise exception using errcode='PT403',message='app_only'; end if;
  if v_parts[2]='r' then
    if n.answer_nonce is distinct from v_parts[3] or n.answer_message_id is distinct from p_message_id or n.answer_text is null or a.kind='action'
      then raise exception using errcode='PT403',message='invalid_answer'; end if;
    v_decision:='respond'; v_response:=jsonb_build_object('text',n.answer_text);
  else
    if n.message_id is null or n.message_id is distinct from p_message_id then raise exception using errcode='PT403',message='invalid_message'; end if;
    if v_parts[2]='c' then
      if v_parts[3] !~ '^[0-9]{1,2}$' or jsonb_typeof(a.params->'choices') is distinct from 'array'
        or jsonb_typeof(a.params->'choices'->(v_parts[3]::int)) is distinct from 'string' then raise exception using errcode='PT422',message='decision_not_offered'; end if;
      v_decision:='respond'; v_response:=jsonb_build_object('text',a.params->'choices'->>(v_parts[3]::int),'choice',a.params->'choices'->>(v_parts[3]::int));
    else
      v_decision:=v_parts[2];
      if v_decision is null or v_decision not in ('approve','reject','ignore') then raise exception using errcode='PT422',message='decision_not_offered'; end if;
    end if;
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',l.user_id,'role','authenticated','app_metadata',jsonb_build_object('principal_type','human'))::text,true);
  perform set_config('request.jwt.claim.sub',l.user_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  if not private.can_write_page(t.row_page_id,t.workspace_id) then raise exception using errcode='PT403',message='forbidden'; end if;
  if n.channel_result is not null then v_result:=n.channel_result;
  else
    v_result:=public.decide_approval(a.id,v_decision,v_response);
    insert into public.agent_activities(workspace_id,task_id,run_id,seq,type,body,author_type,author_id)
      values(t.workspace_id,t.id,a.run_id,private.next_seq(t.id),'action',
        jsonb_build_object('source','telegram','approval_id',a.id,'decision',v_decision,'text','Confirmed through Telegram.'),'human',l.user_id);
    perform private.audit(t.workspace_id,'channel.decide',jsonb_build_object('approval_id',a.id,'source','telegram'));
    v_result:=jsonb_build_object('status','decided','decision',v_decision,'page_id',t.row_page_id,'task_id',t.id);
    update public.channel_notices set channel_result=v_result where id=n.id;
  end if;
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true); perform set_config('request.jwt.claim.sub',coalesce(v_sub,''),true); perform set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  return v_result;
exception when others then
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true); perform set_config('request.jwt.claim.sub',coalesce(v_sub,''),true); perform set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  raise;
end $$;
revoke all on function public.channel_decide(text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.channel_decide(text,text,bigint,text) to service_role;

create or replace function private.channel_notify_tick()
returns void language plpgsql security definer set search_path='' as $$
declare v_url text; v_secret text;
begin
  if not exists(select 1 from public.channel_notices where status='pending' and attempts<5 and next_attempt_at<=now()) then return; end if;
  if to_regclass('vault.decrypted_secrets') is null or not exists(select 1 from pg_extension where extname='pg_net') then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name=$1' into v_url using 'project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name=$1' into v_secret using 'dispatch_cron_secret';
  if v_url is null or v_secret is null then return; end if;
  execute 'select net.http_post(url:=$1,headers:=$2,body:=$3,timeout_milliseconds:=30000)'
    using v_url||'/functions/v1/channel-notify',jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),'{}'::jsonb;
end $$;
revoke all on function private.channel_notify_tick() from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('channel-notify-tick','10 seconds','select private.channel_notify_tick()');
  end if;
end $$;
