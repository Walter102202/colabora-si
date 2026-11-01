import type { Page } from "@/lib/types";
import type { SearchHit } from "@/lib/search";
import { scanStoredSearchRecords } from "@/lib/localPersistence";

export function mergeHits(a: SearchHit[], b: SearchHit[], limit = 12): SearchHit[] {
  const byPage = new Map<string, SearchHit>();
  for (const hit of [...a, ...b]) if (!byPage.has(hit.pageId) || byPage.get(hit.pageId)!.score < hit.score) byPage.set(hit.pageId, hit);
  return [...byPage.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

export async function searchStoredPages(pages: Record<string, Page>, query: string, limit = 12, isCurrent: () => boolean = () => true): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q || !isCurrent()) return [];
  const found = new Map<string, { hit: SearchHit; cell: boolean; detail: number }>();
  const hitFor = (page: Page) => {
    let value = found.get(page.id);
    if (!value) {
      const title = (page.title || "Untitled").toLowerCase();
      value = { hit: { kind: page.parentId && pages[page.parentId]?.database ? "row" : "page", id: page.id, pageId: page.id, title: page.title || "Untitled", snippet: "", score: (title.includes(q) ? 10 : 0) + (title.startsWith(q) ? 5 : 0) }, cell: false, detail: 0 };
      found.set(page.id, value);
    }
    return value;
  };
  const snippet = (value: ReturnType<typeof hitFor>, text: string, priority: number) => {
    if (value.detail >= priority) return;
    const at = text.toLowerCase().indexOf(q);
    value.hit.snippet = text.slice(Math.max(0, at - 20), at + 40).trim(); value.detail = priority;
  };
  try {
    const current = await scanStoredSearchRecords(500, (record) => {
      if (!isCurrent()) return false;
      const page = pages[record.id];
      if (!page || page.isDeleted) return true;
      const value = hitFor(page);
      if (record.text.toLowerCase().includes(q)) { value.hit.score += 3; snippet(value, record.text, 3); }
      if (record.comments.toLowerCase().includes(q)) { value.hit.score += 2; snippet(value, record.comments, 2); }
      // Database records index their rows. A row's own body may be scanned before or after its database.
      for (const [id, text] of Object.entries(record.cells ?? {})) {
        const row = pages[id];
        if (!row || row.isDeleted || !text.toLowerCase().includes(q)) continue;
        const match = hitFor(row);
        if (!match.cell) { match.cell = true; match.hit.score += 4; }
        snippet(match, text, 1);
      }
      return true;
    });
    if (!current) return [];
  } catch { return []; }
  return isCurrent() ? [...found.values()].map(({ hit }) => hit).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit) : [];
}
