begin;
select plan(2);

select tests.fixture() as f \gset

insert into public.notifications (id, workspace_id, user_id, kind, created_at, read_at) values
  ('c0000000-0000-4000-8000-000000000001', (:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, 'mention',
   now() - interval '100 days', now() - interval '100 days'),
  ('c0000000-0000-4000-8000-000000000002', (:'f'::jsonb->>'ws')::uuid, (:'f'::jsonb->>'owner')::uuid, 'mention',
   now() - interval '100 days', null);

select private.agent_retention();

select ok(not exists (select 1 from public.notifications where id = 'c0000000-0000-4000-8000-000000000001'),
          'a notification read more than 90 days ago is removed');
select ok(exists (select 1 from public.notifications where id = 'c0000000-0000-4000-8000-000000000002'),
          'an unread notification stays');

select * from finish();
rollback;
