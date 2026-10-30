begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(id, email)
select ('50000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'push-' || i || '@demo.local'
from generate_series(1, 13) i;
insert into public.workspaces(id, name, owner_id)
values ('50000000-0000-4000-8000-000000000100', 'Push batches', '50000000-0000-4000-8000-000000000001');
-- Person 1 has 200 old-but-still-relevant reminders and no subscription.
-- Person 2 has 200, person 3 has one newer reminder; both can receive push.
insert into public.reminders(id, workspace_id, user_id, remind_at)
select 'push-' || person || '-' || i, '50000000-0000-4000-8000-000000000100',
  ('50000000-0000-4000-8000-' || lpad(person::text, 12, '0'))::uuid,
  now() - interval '3 hours' + person * interval '30 minutes' + i * interval '1 second'
from generate_series(1, 3) person cross join generate_series(1, 200) i
where person < 3 or i = 1;
insert into public.push_subscriptions(endpoint, user_id, p256dh, auth)
select 'https://fcm.googleapis.com/wp/' || i,
  ('50000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'key', 'auth'
from generate_series(2, 3) i;
insert into public.push_subscriptions(endpoint, user_id, p256dh, auth)
values ('https://updates.push.services.mozilla.com/wpush/second-device', '50000000-0000-4000-8000-000000000002', 'key', 'auth');
insert into public.reminders(id, workspace_id, user_id, remind_at, notified, deleted_at)
values
  ('push-stale', '50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', now() - interval '24 hours 1 second', false, null),
  ('push-boundary', '50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', now() - interval '24 hours', false, null),
  ('push-future', '50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', now() + interval '1 second', false, null),
  ('push-notified', '50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', now(), true, null),
  ('push-deleted', '50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', now(), false, now());

-- The original query is trapped by person 1, before subscriptions are loaded.
select is((select count(*) from (
  select user_id from public.reminders where not notified and deleted_at is null and remind_at <= now()
  order by remind_at limit 200
) r where user_id = '50000000-0000-4000-8000-000000000002'), 0::bigint, 'original selection starves a subscribed person');
set local role service_role;
select is((select count(*) from public.due_push_reminders()), 22::bigint, 'only subscribed, due, live reminders within 24 hours qualify');
select is((select count(*) from public.due_push_reminders() where user_id = '50000000-0000-4000-8000-000000000002'), 20::bigint, 'a backlog is capped even with multiple devices');
select ok(exists(select 1 from public.due_push_reminders() where id = 'push-3-1'), 'a newer reminder from another person gets a slot');
select results_eq($$select id from public.due_push_reminders() where user_id = '50000000-0000-4000-8000-000000000002'$$,
  $$select 'push-2-' || i from generate_series(1, 20) i$$, 'each person is served oldest first');
select is((select notified from public.reminders where id = 'push-stale'), false, 'stale reminder stays available in the app');
select is((select count(*) from public.reminders where user_id = '50000000-0000-4000-8000-000000000001' and notified), 0::bigint, 'unsubscribed reminders are not marked notified');
reset role;

-- Enough people to fill a pass: everybody gets their first row before seconds.
insert into public.push_subscriptions(endpoint, user_id, p256dh, auth)
select 'https://fcm.googleapis.com/wp/' || i,
  ('50000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'key', 'auth'
from generate_series(4, 13) i;
insert into public.reminders(id, workspace_id, user_id, remind_at)
select 'push-' || person || '-' || i, '50000000-0000-4000-8000-000000000100',
  ('50000000-0000-4000-8000-' || lpad(person::text, 12, '0'))::uuid, now()
from generate_series(4, 13) person cross join generate_series(1, 25) i;
set local role service_role;
select is((select count(*) from public.due_push_reminders()), 200::bigint, 'the pass is bounded to 200');
select is((select count(distinct user_id) from (select * from public.due_push_reminders() limit 12) r), 12::bigint, 'the first round reaches every eligible person');
reset role;

insert into public.notifications(workspace_id, user_id, kind, created_at)
select '50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000001', 'input_required', now() - interval '2 days'
from generate_series(1, 200);
insert into public.notifications(workspace_id, user_id, kind, created_at, pushed_at)
values
  ('50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', 'ready_for_review', now(), null),
  ('50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', 'mention', now(), null),
  ('50000000-0000-4000-8000-000000000100', '50000000-0000-4000-8000-000000000003', 'task_failed', now(), now());
set local role service_role;
select is((select count(*) from public.pending_push_notifications()), 21::bigint, 'agent cleanup also has a per-person cap and ignores other kinds or pushed rows');
select ok(exists(select 1 from public.pending_push_notifications() where kind = 'ready_for_review'), 'an unsubscribed agent-notification backlog cannot crowd out another person');
reset role;

set local role anon;
select throws_ok($$select * from public.due_push_reminders()$$, '42501', null, 'anonymous callers cannot read the privileged reminder batch');
select throws_ok($$select * from public.pending_push_notifications()$$, '42501', null, 'anonymous callers cannot read the privileged notification batch');
reset role;
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.due_push_reminders()$$, '42501', null, 'signed-in people cannot read other peoples reminders');
select throws_ok($$select * from public.pending_push_notifications()$$, '42501', null, 'signed-in people cannot read other peoples notifications');
reset role;
select * from finish();
rollback;
