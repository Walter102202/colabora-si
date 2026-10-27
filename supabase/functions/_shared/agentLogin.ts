// Login identity of an agent's auth user. agent-admin sets it, agent-token uses it.
import { hmacSha256Hex } from './hmac.ts';

export function agentEmail(agentId: string): string {
  return `agent+${agentId}@agents.invalid`;
}

/** Password derived from the auth user id; `nonce` comes from agents.connection.login_nonce after a rotation. */
export function agentLoginPassword(pepper: string, authUserId: string, nonce?: string | null): Promise<string> {
  return hmacSha256Hex(pepper, nonce ? `${authUserId}:${nonce}` : authUserId);
}

export function randomHex(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
