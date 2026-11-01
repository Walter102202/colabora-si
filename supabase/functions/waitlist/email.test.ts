import assert from 'node:assert/strict';
import { sendConfirmation, WAITLIST_EMAIL } from './email.ts';

const { html, text, subject, from } = WAITLIST_EMAIL;

Deno.test('the message says what was approved', () => {
  assert.equal(from, 'colabora.si <hello@colabora.si>');
  assert.equal(subject, "You're on the colabora.si waitlist");
  assert.equal(text, "You're on the list.\nWe'll write to you when your invite is ready.\n\ncolabora.si\n");
  assert.ok(html.includes('You’re on&nbsp;the&nbsp;list.'));
  assert.ok(html.includes('We’ll write to you when your&nbsp;invite&nbsp;is&nbsp;ready.'));
});

Deno.test('the markup stays safe for mail clients', () => {
  assert.ok(new TextEncoder().encode(html).length < 102_000, 'Gmail clips larger messages');
  assert.ok(html.includes('<html lang="en"'));
  assert.equal(/<(script|link|svg)\b/i.test(html), false);
  const tables = html.match(/<table\b[^>]*>/g) ?? [];
  assert.ok(tables.length > 0);
  for (const table of tables) assert.ok(table.includes('role="presentation"'), table);
});

Deno.test('every resource lives on colabora.si', () => {
  const urls = (html.match(/https?:\/\/[^"')\s]+/g) ?? []).filter((url) => !url.startsWith('http://www.w3.org/'));
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(url.startsWith('https://colabora.si/'), url);
});

Deno.test('the Trama avatar is the approved image, unaltered', () => {
  const images = html.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(images.length, 1);
  assert.ok(images[0].includes('src="https://colabora.si/brand/trama/v1/trama-128.png"'));
  assert.ok(images[0].includes('alt=""'));
  assert.equal(/border-radius|filter|opacity|mask|clip/i.test(images[0]), false);
});

Deno.test('Resend receives one idempotent message', async () => {
  let url = '';
  let init: RequestInit | undefined;
  const send = ((to: string, options: RequestInit) => { url = to; init = options; return Promise.resolve(new Response('{}')); }) as typeof fetch;
  await sendConfirmation('key', 'ana@company.co', 'row', send);
  assert.equal(url, 'https://api.resend.com/emails');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer key');
  assert.equal(headers.get('Idempotency-Key'), 'waitlist/row');
  assert.deepEqual(JSON.parse(String(init?.body)), { from, to: ['ana@company.co'], subject, html, text });
  assert.ok(init?.signal, 'the send has a timeout');
});

Deno.test('a Resend refusal is a failure', async () => {
  const send = (() => Promise.resolve(new Response('{}', { status: 429 }))) as typeof fetch;
  await assert.rejects(sendConfirmation('key', 'a@b.co', 'row', send), /resend answered 429/);
});
