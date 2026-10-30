import assert from 'node:assert/strict';
import { hmacSha256Hex } from './hmac.ts';
import { validSignature, webhookSecret } from './ciWebhook.ts';

Deno.test('GitHub signatures cover the raw body and belong to one connection', async () => {
  const secret = await webhookSecret('pepper', 'connection');
  const other = await webhookSecret('pepper', 'other');
  assert.equal(secret, await hmacSha256Hex('pepper', 'github-webhook:connection'));
  const body = '{ "check_run": {} }';
  const signature = `sha256=${await hmacSha256Hex(secret, body)}`;
  assert.equal(await validSignature(secret, body, signature), true);
  assert.equal(await validSignature(secret, body + ' ', signature), false);
  assert.equal(await validSignature(other, body, signature), false);
  assert.equal(await validSignature(secret, body, null), false);
  assert.equal(await validSignature(secret, body, 'sha1=abc'), false);
});
