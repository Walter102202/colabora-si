// The rows the owner marked in the waitlist database. Besides the Email title it needs a checkbox called Invite, a date
// called Invited and a text property called Invite error, and the integration must be able to read and update content.
import type { InviteRow } from './handler.ts';

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 5_000;
const BATCH = 10;

export class NotionError extends Error {
  constructor(readonly status: number) {
    super(`notion answered ${status}`);
    this.name = 'NotionError';
  }
}

interface NotionPage { id: string; properties?: { Email?: { title?: { plain_text?: string }[] } } }

function request(token: string, method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': NOTION_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

export async function pendingInvites(token: string, databaseId: string, send: typeof fetch = fetch): Promise<InviteRow[]> {
  const res = await send(`${NOTION}/databases/${encodeURIComponent(databaseId)}/query`, request(token, 'POST', {
    page_size: BATCH,
    filter: { and: [
      { property: 'Invite', checkbox: { equals: true } },
      { property: 'Invited', date: { is_empty: true } },
      { property: 'Invite error', rich_text: { is_empty: true } },
    ] },
  }));
  if (!res.ok) {
    await res.body?.cancel();
    throw new NotionError(res.status);
  }
  const { results } = await res.json() as { results?: NotionPage[] };
  return (results ?? []).map((page) => ({
    id: page.id,
    email: (page.properties?.Email?.title ?? []).map((part) => part.plain_text ?? '').join(''),
  }));
}

async function update(token: string, pageId: string, properties: unknown, send: typeof fetch): Promise<void> {
  const res = await send(`${NOTION}/pages/${encodeURIComponent(pageId)}`, request(token, 'PATCH', { properties }));
  await res.body?.cancel();
  if (!res.ok) throw new NotionError(res.status);
}

export function markInvited(token: string, pageId: string, at: Date, send: typeof fetch = fetch): Promise<void> {
  return update(token, pageId, { Invited: { date: { start: at.toISOString() } } }, send);
}

export function markInviteError(token: string, pageId: string, message: string, send: typeof fetch = fetch): Promise<void> {
  return update(token, pageId, { 'Invite error': { rich_text: [{ text: { content: message } }] } }, send);
}
