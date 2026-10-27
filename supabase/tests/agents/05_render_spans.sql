begin;
select plan(10);

select tests.fixture() as f \gset

-- Raw markup is escaped, never interpreted.
select is(private.render_spans('["<script>alert(1)</script>"]'::jsonb),
          '&lt;script&gt;alert(1)&lt;/script&gt;', 'a script tag in text is escaped');
select is(private.render_spans('[{"text":"\"><img src=x onerror=alert(1)>"}]'::jsonb),
          '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;', 'an attribute breakout in text is escaped');
select ok(position('<img' in private.render_spans('[{"text":"x","href":"\"><img src=x onerror=alert(1)>"}]'::jsonb)) = 0,
          'an attribute breakout in href is escaped inside the attribute');

-- Unsafe schemes lose the link; the text stays.
select is(private.render_spans('[{"text":"x","href":"javascript:alert(1)"}]'::jsonb), 'x', 'javascript: links are dropped');
select is(private.render_spans(jsonb_build_array(jsonb_build_object('text', 'x', 'href', E'JAVA\nSCRIPT:alert(1)'))), 'x',
          'javascript: split by a newline and in capitals is dropped');
select is(private.render_spans('[{"text":"x","href":"data:text/html,<script>alert(1)</script>"}]'::jsonb), 'x', 'data: links are dropped');

-- Safe schemes pass.
select is(private.render_spans('[{"text":"mail","href":"mailto:team@example.com"}]'::jsonb),
          '<a href="mailto:team@example.com">mail</a>', 'mailto: links pass');
select is(private.render_spans('[{"text":"site","bold":true,"href":"https://example.com/a?b=1&c=2"}]'::jsonb),
          '<a href="https://example.com/a?b=1&amp;c=2"><strong>site</strong></a>', 'https: links pass, escaped');

-- Mentions must point at something real.
select is(private.render_spans('[{"mention":"page","pageId":"page_A"}]'::jsonb),
          '<a class="mention" data-page="page_A" href="/p/page_A">Page A</a>', 'a page mention renders as a link');
select is(tests.sqlstate_of($$select private.render_spans('[{"mention":"page","pageId":"no_such_page"}]'::jsonb)$$), 'PT422',
          'a mention of a missing page raises PT422');

select * from finish();
rollback;
