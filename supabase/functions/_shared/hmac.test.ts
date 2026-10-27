import assert from 'node:assert/strict';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from './hmac.ts';

Deno.test('hmacSha256Hex matches RFC 4231 test case 2', async () => {
  assert.equal(
    await hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
});

Deno.test('sha256Hex matches the FIPS 180-2 "abc" vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test('timingSafeEqual compares content and length', () => {
  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeEqual('abc', 'abc1'), false);
  assert.equal(timingSafeEqual('', ''), true);
});
