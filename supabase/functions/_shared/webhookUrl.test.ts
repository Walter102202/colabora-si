import { assertEquals } from 'jsr:@std/assert@1';
import { isBlockedIp, webhookUrlError } from './webhookUrl.ts';

Deno.test('webhookUrlError accepts public https endpoints only', () => {
  assertEquals(webhookUrlError('https://hook.example/agent'), null);
  assertEquals(webhookUrlError('https://hook.example:8443/a?b=1'), null);
  assertEquals(webhookUrlError('https://93.184.216.34/'), null);
  assertEquals(webhookUrlError('https://[2606:4700::6810:84e5]/'), null);
  assertEquals(webhookUrlError('http://hook.example/agent'), 'webhook_url_not_https');
  assertEquals(webhookUrlError('not a url'), 'webhook_url_invalid');
  assertEquals(webhookUrlError('https://user:pw@hook.example/'), 'webhook_url_has_credentials');
});

Deno.test('webhookUrlError blocks loopback, private, link-local and metadata destinations', () => {
  for (const u of [
    'https://localhost/', 'https://localhost./', 'https://app.localhost/', 'https://LOCALHOST/', 'https://metadata.google.internal./',
    'https://127.0.0.1/', 'https://10.1.2.3/', 'https://172.16.0.9/', 'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/', 'https://192.0.0.9/', 'https://198.18.0.1/', 'https://0.0.0.0/', 'https://db.internal/',
    'https://[::1]/', 'https://[::]/', 'https://[fe80::1]/', 'https://[fec0::1]/', 'https://[fd12::1]/', 'https://[ff02::1]/',
    'https://[::ffff:10.0.0.1]/', 'https://[::ffff:a00:1]/', 'https://[::ffff:0:a9fe:a9fe]/', 'https://[::7f00:1]/',
    'https://[64:ff9b::a9fe:a9fe]/', 'https://[64:ff9b:1::7f00:1]/', 'https://[2002:c0a8:101::]/', 'https://[2001:db8::1]/', 'https://[2001::1]/',
  ]) assertEquals(webhookUrlError(u), 'webhook_url_private', u);
});

Deno.test('isBlockedIp vets resolved addresses and rejects what it cannot parse', () => {
  assertEquals(isBlockedIp('93.184.216.34'), false);
  assertEquals(isBlockedIp('2606:4700::6810:84e5'), false);
  assertEquals(isBlockedIp('10.0.0.1'), true);
  assertEquals(isBlockedIp('::ffff:127.0.0.1'), true);
  assertEquals(isBlockedIp('[fe80::1]'), true);
  assertEquals(isBlockedIp('not-an-ip'), true);
});
