// One page in the owner's Notion database for each new address. The database needs a title property called Email and
// a date property called Joined, and the integration must be connected to it.
const NOTION_PAGES = 'https://api.notion.com/v1/pages';
const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 3_000;

export async function addToNotion(token: string, databaseId: string, email: string, at: Date, send: typeof fetch = fetch): Promise<void> {
  const res = await send(NOTION_PAGES, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': NOTION_VERSION },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        Email: { title: [{ text: { content: email } }] },
        Joined: { date: { start: at.toISOString() } },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`notion answered ${res.status}`);
}
