import { computeCell, displayValue } from "@/lib/dbCompute";
import { stripHtml } from "@/lib/utils";
import type { Block, Page } from "@/lib/types";

export type SearchHitKind = "page" | "row" | "task";
export interface SearchHit { kind: SearchHitKind; id: string; pageId: string; blockId?: string; title: string; snippet: string; score: number }

function blocksText(blocks: Block[], synced: Record<string, Block[]>, seen = new Set<string>()): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "table") for (const row of b.table ?? []) for (const cell of row) parts.push(stripHtml(cell));
    else if (b.type === "columns") for (const column of b.columns ?? []) parts.push(blocksText(column.blocks, synced, seen));
    else if (b.type === "synced") { const key = b.syncedFrom ?? b.id; if (!seen.has(key)) { seen.add(key); parts.push(blocksText(synced[key] ?? [], synced, seen)); seen.delete(key); } }
    else parts.push(b.type === "code" ? b.html : stripHtml(b.html));
  }
  return parts.join(" ");
}

export function rankLocal(pages: Record<string, Page>, synced: Record<string, Block[]>, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase(), values = Object.values(pages).filter((p) => !p.isDeleted);
  if (!q) return [];
  const cells = new Map<string, string[]>();
  for (const page of values) if (page.database) {
    const database = page.database, props = database.properties.filter((p) => p.id !== "title" && ["text", "url", "email", "phone", "person", "select", "multiSelect", "status"].includes(p.type));
    for (const row of database.rows) cells.set(row.pageId, [...(cells.get(row.pageId) ?? []), props.map((p) => displayValue(computeCell(row, p, database, pages), p, database, pages)).join(" ")]);
  }
  return values.map((page): SearchHit => {
    const title = (page.title || "Untitled").toLowerCase(), body = blocksText(page.blocks, synced), comments = (page.comments ?? []).map((c) => c.body).join(" ");
    const cell = cells.get(page.id)?.find((c) => c.toLowerCase().includes(q));
    const score = (title.includes(q) ? 10 : 0) + (title.startsWith(q) ? 5 : 0) + (body.toLowerCase().includes(q) ? 3 : 0) + (comments.toLowerCase().includes(q) ? 2 : 0) + (cell ? 4 : 0);
    const text = [body, comments, cell ?? ""].find((t) => t.toLowerCase().includes(q)) ?? "", at = text.toLowerCase().indexOf(q);
    return { kind: page.parentId && pages[page.parentId]?.database ? "row" : "page", id: page.id, pageId: page.id, title: page.title || "Untitled", score, snippet: text ? text.slice(Math.max(0, at - 20), at + 40).trim() : "" };
  }).filter((r) => r.score).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function hitFromRemote(value: unknown): SearchHit | null {
  if (!value || typeof value !== "object") return null;
  const h = value as Record<string, unknown>;
  if ((h.kind !== "page" && h.kind !== "row" && h.kind !== "task") || typeof h.id !== "string" || typeof h.pageId !== "string" || typeof h.title !== "string" || typeof h.snippet !== "string" || typeof h.score !== "number" || !Number.isFinite(h.score) || (h.blockId !== undefined && typeof h.blockId !== "string")) return null;
  return { kind: h.kind, id: h.id, pageId: h.pageId, title: h.title, snippet: stripHtml(h.snippet), score: h.score, ...(h.blockId === undefined ? {} : { blockId: h.blockId }) };
}

export function recentHits(pages: Record<string, Page>, limit = 8): SearchHit[] {
  return Object.values(pages).filter((p) => !p.isDeleted).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((page) => ({ kind: page.parentId && pages[page.parentId]?.database ? "row" : "page", id: page.id, pageId: page.id, title: page.title || "Untitled", snippet: "", score: 0 }));
}
