-- The landing's waitlist. Only the waitlist function reaches it, with the service role: no browser, member or agent
-- reads or writes a row. Attempts are counted per hour and keep hashes, never an address.
create table private.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  source text not null default 'landing' check (char_length(source) between 1 and 64),
  notion_synced_at timestamptz,
  created_at timestamptz not null default now()
);
alter table private.waitlist enable row level security;
revoke all on private.waitlist from public,anon,authenticated;

create table private.waitlist_attempts (
  key text not null,
  window_start timestamptz not null,
  attempts integer not null default 1,
  primary key (key, window_start)
);
create index waitlist_attempts_window on private.waitlist_attempts(window_start);
alter table private.waitlist_attempts enable row level security;
revoke all on private.waitlist_attempts from public,anon,authenticated;

create or replace function private.waitlist_within_limit(p_key text, p_limit integer)
returns boolean language sql security definer set search_path='' as $$
  insert into private.waitlist_attempts as a(key,window_start) values (p_key,date_trunc('hour',now()))
  on conflict (key,window_start) do update set attempts=a.attempts+1
  returning attempts<=p_limit;
$$;
revoke all on function private.waitlist_within_limit(text,integer) from public,anon,authenticated;

-- A limit returns an outcome instead of raising, so the attempt that hit it stays counted.
create or replace function public.waitlist_join(p_email text, p_ip_hash text, p_source text default 'landing')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_email text:=lower(btrim(p_email));
  v_within_ip boolean;
  v_within_email boolean;
  v_id uuid;
begin
  if v_email is null or char_length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
    then raise exception using errcode='PT400',message='invalid_email'; end if;
  if coalesce(p_ip_hash,'')='' then raise exception using errcode='PT400',message='invalid_request'; end if;
  delete from private.waitlist_attempts where window_start<date_trunc('hour',now());
  v_within_ip:=private.waitlist_within_limit('ip:'||p_ip_hash,20);
  v_within_email:=private.waitlist_within_limit('email:'||encode(extensions.digest(v_email,'sha256'),'hex'),5);
  if not (v_within_ip and v_within_email) then return jsonb_build_object('outcome','rate_limited'); end if;
  insert into private.waitlist(email,source) values (v_email,coalesce(nullif(p_source,''),'landing'))
  on conflict (email) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('outcome','exists'); end if;
  return jsonb_build_object('outcome','added','id',v_id);
end $$;
revoke all on function public.waitlist_join(text,text,text) from public,anon,authenticated;
grant execute on function public.waitlist_join(text,text,text) to service_role;

create or replace function public.waitlist_mark_synced(p_id uuid)
returns void language sql security definer set search_path='' as $$
  update private.waitlist set notion_synced_at=now() where id=p_id;
$$;
revoke all on function public.waitlist_mark_synced(uuid) from public,anon,authenticated;
grant execute on function public.waitlist_mark_synced(uuid) to service_role;
