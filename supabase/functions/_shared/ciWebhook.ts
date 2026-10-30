import { hmacSha256Hex, timingSafeEqual } from './hmac.ts';

/** One secret per connection, derived so that nothing secret is stored. */
export function webhookSecret(pepper: string, connectionId: string): Promise<string> {
  return hmacSha256Hex(pepper, `github-webhook:${connectionId}`);
}

export async function validSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  return timingSafeEqual(`sha256=${await hmacSha256Hex(secret, body)}`, header);
}
