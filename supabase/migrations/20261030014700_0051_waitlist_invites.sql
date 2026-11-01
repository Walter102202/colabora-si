-- Every minute the waitlist-invites function reads the rows the owner marked in Notion. Nothing is granted to callers.
create or replace function private.waitlist_invites_tick()
returns void language plpgsql security definer set search_path='' as $$
declare v_url text; v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null or not exists(select 1 from pg_extension where extname='pg_net') then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name=$1' into v_url using 'project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name=$1' into v_secret using 'dispatch_cron_secret';
  if v_url is null or v_secret is null then return; end if;
  execute 'select net.http_post(url:=$1,headers:=$2,body:=$3,timeout_milliseconds:=60000)'
    using v_url||'/functions/v1/waitlist-invites',jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),'{}'::jsonb;
end $$;
revoke all on function private.waitlist_invites_tick() from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('waitlist-invites','* * * * *','select private.waitlist_invites_tick()');
  end if;
end $$;
