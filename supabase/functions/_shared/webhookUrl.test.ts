import { assertEquals } from 'jsr:@std/assert@1';
import { webhookUrlError } from './webhookUrl.ts';

Deno.test('webhookUrlError accepts public https endpoints only', () => {
  assertEquals(webhookUrlError('https://hook.example/agent'), null);
  assertEquals(webhookUrlError('https://hook.example:8443/a?b=1'), null);
  assertEquals(webhookUrlError('http://hook.example/agent'), 'webhook_url_not_https');
  assertEquals(webhookUrlError('not a url'), 'webhook_url_invalid');
  assertEquals(webhookUrlError('https://user:pw@hook.example/'), 'webhook_url_has_credentials');
});

Deno.test('webhookUrlError blocks loopback, private, link-local and metadata destinations', () => {
  for (const u of [
    'https://localhost/', 'https://app.localhost/', 'https://127.0.0.1/', 'https://10.1.2.3/', 'https://172.16.0.9/',
    'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data', 'https://metadata.google.internal/',
    'https://[::1]/', 'https://[fe80::1]/', 'https://[::ffff:10.0.0.1]/', 'https://db.internal/', 'https://0.0.0.0/',
  ]) assertEquals(webhookUrlError(u), 'webhook_url_private', u);
});
