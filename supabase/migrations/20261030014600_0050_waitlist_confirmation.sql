-- The waitlist's confirmation email and Notion copy. A row without a date is still owed that step, so a refused send, a
-- full daily quota, a Notion failure and a signup from before these steps existed are all retried by later signups. As in
-- 0049, only the service role gets here.
alter table private.waitlist add column confirmation_sent_at timestamptz;

-- Random order: an address the provider keeps refusing cannot hold back the rows behind it.
create or replace function public.waitlist_unconfirmed(p_limit integer)
returns table(id uuid, email text) language sql security definer set search_path='' as $$
  select w.id,w.email from private.waitlist w where w.confirmation_sent_at is null order by random() limit greatest(p_limit,0);
$$;
revoke all on function public.waitlist_unconfirmed(integer) from public,anon,authenticated;
grant execute on function public.waitlist_unconfirmed(integer) to service_role;

create or replace function public.waitlist_mark_confirmed(p_id uuid)
returns void language sql security definer set search_path='' as $$
  update private.waitlist set confirmation_sent_at=now() where id=p_id;
$$;
revoke all on function public.waitlist_mark_confirmed(uuid) from public,anon,authenticated;
grant execute on function public.waitlist_mark_confirmed(uuid) to service_role;

create or replace function public.waitlist_unsynced(p_limit integer)
returns table(id uuid, email text, created_at timestamptz) language sql security definer set search_path='' as $$
  select w.id,w.email,w.created_at from private.waitlist w where w.notion_synced_at is null order by random() limit greatest(p_limit,0);
$$;
revoke all on function public.waitlist_unsynced(integer) from public,anon,authenticated;
grant execute on function public.waitlist_unsynced(integer) to service_role;
