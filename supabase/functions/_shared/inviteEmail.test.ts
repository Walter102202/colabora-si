import assert from 'node:assert/strict';
import { INVITE_EMAIL, inviteHtml, inviteText, inviteUrl, sendInvite } from './inviteEmail.ts';

const APP = 'https://colabora.si';
const TOKEN = 'a1b2c3';
const URL_OF_TOKEN = `${APP}/set-password?token_hash=${TOKEN}&type=invite#ana%40company.co`;
const html = inviteHtml(URL_OF_TOKEN);
const text = inviteText(URL_OF_TOKEN);

function admin(answer: Awaited<ReturnType<Parameters<typeof sendInvite>[0]['generateLink']>>) {
  const calls: unknown[] = [];
  return {
    calls,
    generateLink(params: { type: 'invite'; email: string }) {
      calls.push(params);
      return Promise.resolve(answer);
    },
  };
}

const issued = { data: { properties: { hashed_token: TOKEN } }, error: null };

Deno.test('the message says what was approved', () => {
  assert.equal(INVITE_EMAIL.from, 'colabora.si <hello@colabora.si>');
  assert.equal(INVITE_EMAIL.subject, 'Your colabora.si invite is ready');
  assert.equal(text, `You're in.\nWelcome to colabora.si, a shared workspace for people and AI agents.\n\nAccept your invite:\n${URL_OF_TOKEN}\n\nThis link is just for you and works for 24 hours.\n\ncolabora.si\n`);
  assert.ok(html.includes('You’re in.'));
  assert.ok(html.includes('a&nbsp;shared workspace for&nbsp;people and&nbsp;AI&nbsp;agents.'));
  assert.ok(html.includes('Set your password to get started.'));
  assert.ok(html.includes('>Accept your invite</a>'));
  assert.ok(html.includes('This link is just for you and works for 24 hours.'));
});

Deno.test('the link goes to the password page, carries the one-time hash and keeps the address off the server', () => {
  const url = new URL(inviteUrl(APP, TOKEN, 'ana+beta@company.co'));
  assert.equal(url.origin + url.pathname, 'https://colabora.si/set-password');
  assert.equal(url.searchParams.get('token_hash'), TOKEN);
  assert.equal(url.searchParams.get('type'), 'invite');
  assert.equal(decodeURIComponent(url.hash.slice(1)), 'ana+beta@company.co');
  assert.equal(url.search.includes('ana'), false);
});

Deno.test('the link appears once in each version and is escaped in the markup', () => {
  const unsafe = 'https://colabora.si/set-password?a="><script>&b=1';
  const markup = inviteHtml(unsafe);
  assert.equal(markup.includes('<script>'), false);
  assert.equal(markup.split('href="https://colabora.si/set-password?a=&quot;&gt;&lt;script&gt;&amp;b=1"').length, 2);
  assert.equal(inviteText(unsafe).split(unsafe).length, 2);
});

Deno.test('the button is the design: one table cell, with its Outlook padding and dark colors', () => {
  assert.ok(html.includes('bgcolor="#176bb5"'));
  assert.ok(html.includes('mso-padding-alt:13px 22px'));
  assert.ok(html.includes('.e-btn{background-color:#88c3f7 !important}'));
  assert.ok(html.includes('.e-btn-ink{color:#142838 !important}'));
  assert.ok(html.includes('.e-mark:hover{text-decoration:underline !important}'));
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

Deno.test('an invitation leaves Auth without a mail of its own and reaches Resend once, per token', async () => {
  const auth = admin(issued);
  let url = '';
  let init: RequestInit | undefined;
  const send = ((to: string, options: RequestInit) => { url = to; init = options; return Promise.resolve(new Response('{}')); }) as typeof fetch;
  assert.equal(await sendInvite(auth, 'key', APP, 'ana@company.co', send), null);
  assert.deepEqual(auth.calls, [{ type: 'invite', email: 'ana@company.co' }]);
  assert.equal(url, 'https://api.resend.com/emails');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer key');
  assert.equal(headers.get('Idempotency-Key'), `invite/${TOKEN}`);
  const link = inviteUrl(APP, TOKEN, 'ana@company.co');
  assert.deepEqual(JSON.parse(String(init?.body)), {
    from: INVITE_EMAIL.from,
    to: ['ana@company.co'],
    subject: INVITE_EMAIL.subject,
    html: inviteHtml(link),
    text: inviteText(link),
  });
  assert.ok(init?.signal, 'the send has a timeout');
});

Deno.test('an Auth refusal comes back as it is and sends nothing', async () => {
  const send = (() => { throw new Error('must not send'); }) as typeof fetch;
  const failure = await sendInvite(admin({ data: { properties: null }, error: { status: 422, code: 'email_exists' } }), 'key', APP, 'ana@company.co', send);
  assert.deepEqual(failure, { status: 422, code: 'email_exists' });
});

Deno.test('a link without its token is a failure to retry', async () => {
  const send = (() => { throw new Error('must not send'); }) as typeof fetch;
  assert.deepEqual(await sendInvite(admin({ data: { properties: {} }, error: null }), 'key', APP, 'a@b.co', send), { status: 502, code: 'no_token' });
});

Deno.test('Resend failures are answers, never exceptions, and never read as an existing account', async () => {
  const answering = (status: number) => (() => Promise.resolve(new Response('{}', { status }))) as typeof fetch;
  assert.deepEqual(await sendInvite(admin(issued), 'key', APP, 'a@b.co', answering(429)), { status: 429, code: 'email_rate_limited' });
  assert.deepEqual(await sendInvite(admin(issued), 'key', APP, 'a@b.co', answering(503)), { status: 503, code: 'email_unavailable' });
  assert.deepEqual(await sendInvite(admin(issued), 'key', APP, 'a@b.co', answering(422)), { status: 400, code: 'email_refused' });
  assert.deepEqual(await sendInvite(admin(issued), 'key', APP, 'a@b.co', answering(403)), { status: 400, code: 'email_refused' });
  const down = (() => Promise.reject(new TypeError('connection refused'))) as typeof fetch;
  assert.deepEqual(await sendInvite(admin(issued), 'key', APP, 'a@b.co', down), { status: 502, code: 'email_unreachable' });
});
