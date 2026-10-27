-- Agent blocks may carry a stable section key, which the app reads back (brief:* sections of a task row).
begin;
select plan(4);

select is(private.render_block('{"type":"heading2","spans":["Goal"],"key":"brief:goal"}'::jsonb)->>'key', 'brief:goal',
          'a valid key is kept on the rendered block');
select ok(not (private.render_block('{"type":"paragraph","spans":["x"]}'::jsonb) ? 'key'),
          'a block without key gets none');
select is(tests.sqlstate_of($$ select private.render_block('{"type":"paragraph","spans":["x"],"key":"<b>"}'::jsonb) $$), 'PT400',
          'a key with markup is rejected');
select is(tests.sqlstate_of($$ select private.render_block(('{"type":"paragraph","spans":["x"],"key":"' || repeat('k', 65) || '"}')::jsonb) $$), 'PT400',
          'a key over 64 characters is rejected');

select * from finish();
rollback;
