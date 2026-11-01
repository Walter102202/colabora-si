import assert from 'node:assert/strict';
import { deliverAccountLink } from './accountEmail.ts';
import { inviteHtml, recoveryCopy, workspaceCopy } from './inviteEmail.ts';

Deno.test('recovery and workspace invite deliver custom mail, keep workspace token and text version', async () => {
  for (const confirmed of [false, true]) {
    const calls: unknown[] = []; const messages: Record<string, string>[] = [];
    const links = { generateLink: async (params: unknown) => { calls.push(params); return { data: { properties: { hashed_token: 'hash' } }, error: null }; } };
    const send: typeof fetch = async (_url, init) => { messages.push(JSON.parse(String(init?.body))); return new Response('{}'); };
    await deliverAccountLink(links, 'fake', 'https://colabora.si', 'person@test.local', { exists: confirmed, confirmed, workspace: { name: '<Workspace>', inviter: 'A & B' } }, 'workspace-token', send);
    assert.deepEqual(calls, [{ type: confirmed ? 'recovery' : 'invite', email: 'person@test.local' }]);
    assert.ok(messages[0].html.includes('A &amp; B invited you to &lt;Workspace&gt;'));
    assert.ok(messages[0].text.includes('invite=workspace-token#person%40test.local'));
    assert.ok(messages[0].text.includes('A & B invited you to <Workspace>'));
  }
  const copy = workspaceCopy('x'.repeat(500) + '\r\n', 'y'.repeat(500));
  assert.ok(copy.subject.length < 220);
  assert.ok(!copy.subject.includes('\n'));
  assert.ok(inviteHtml('https://colabora.si', recoveryCopy).includes("If you didn’t ask for it"));
});
