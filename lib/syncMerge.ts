import type { Actor, Block, DbProperty, DbView, Page, PageFont, Reminder, WorkspaceSettings } from "@/lib/types";
import { shellFromMeta, type PageMeta } from "@/lib/pageShell";

export interface PageRow {
  id: string; parent_id?: string | null; data: (Page & { _client?: string }) | null;
  deleted_at: string | null; updated_at: string; revision: number;
  last_edited_by?: string | null; last_edited_by_type?: Actor["type"] | "system" | null; last_edit_run_id?: string | null;
}
export interface PageMetaRow extends Omit<PageRow, "data"> {
  data_id: string | null; title: string | null; icon: string | null; cover: string | null; coverPosition: number | null;
  rowOrigin: Page["rowOrigin"] | null; fullWidth: boolean | null; smallText: boolean | null; locked: boolean | null; font: PageFont | null; isFavorite: boolean | null;
  isDeleted: boolean | null; createdAt: number | null; dbId: string | null; dbProperties: DbProperty[] | null; dbViews: DbView[] | null; dbLocked: boolean | null;
}
export function rowFromMeta(row: PageMetaRow): PageRow {
  const { data_id, title, icon, cover, coverPosition, rowOrigin, fullWidth, smallText, locked, font, isFavorite, isDeleted, createdAt, dbId, dbProperties, dbViews, dbLocked, ...columns } = row;
  if (!data_id && columns.deleted_at) return { ...columns, data: null };
  const updatedAt = Date.parse(columns.updated_at);
  const meta: PageMeta = {
    id: columns.id, title: title ?? "", icon: icon ?? null, cover: cover ?? null, ...(coverPosition == null ? {} : { coverPosition }),
    ...(rowOrigin ? { rowOrigin } : {}), parentId: columns.parent_id ?? null, isFavorite: !!isFavorite, isDeleted: !!isDeleted, fullWidth: !!fullWidth, smallText: !!smallText,
    ...(locked ? { locked } : {}), ...(font ? { font } : {}), createdAt: createdAt ?? updatedAt, updatedAt, revision: columns.revision,
    ...(dbId ? { database: { id: dbId, properties: dbProperties ?? [], views: dbViews ?? [], ...(dbLocked ? { locked: dbLocked } : {}) } } : {}),
    bodyRev: null, links: [],
  };
  return { ...columns, data: shellFromMeta(meta) };
}
export interface WorkspaceRow {
  id: string; name: string; root_order: string[] | null; synced_blocks: Record<string, Block[]> | null;
  settings: WorkspaceSettings | null; updated_at: string; revision: number;
}
export interface ReminderRow {
  id: string; page_id: string | null; block_id?: string | null; body: string;
  remind_at: string; notified: boolean; deleted_at: string | null;
}
export function pageFromRow(row: PageRow): Page | null {
  if (!row.data) return null;
  const page = { ...row.data }; delete page._client;
  return { ...page, revision: row.revision, updatedAt: Date.parse(row.updated_at),
    ...(row.parent_id === undefined ? {} : { parentId: row.parent_id }),
    ...(row.last_edited_by && row.last_edited_by_type !== "system" ? { lastEditedBy: { id: row.last_edited_by, type: row.last_edited_by_type ?? "human", ...(row.last_edit_run_id ? { runId: row.last_edit_run_id } : {}) } } : {}),
  };
}
export function reminderFromRow(row: ReminderRow): Reminder {
  return { id: row.id, date: row.remind_at, pageId: row.page_id ?? "", ...(row.block_id ? { blockId: row.block_id } : {}), text: row.body, createdAt: Date.now(), notified: !!row.notified };
}
export type PageMergeDecision = { kind: "push"; page: Page } | { kind: "apply"; page: Page; serverMs: number } | { kind: "delete"; serverMs: number } | { kind: "skip" };
export function mergePageDecision(local: Page | undefined, row: PageRow, isForeign: boolean): PageMergeDecision {
  const serverMs = Date.parse(row.updated_at), remote = pageFromRow(row);
  if (!remote) {
    if (row.deleted_at && local && !isForeign) return local.updatedAt > serverMs ? { kind: "push", page: local } : { kind: "delete", serverMs };
    return { kind: "skip" };
  }
  return { kind: "apply", page: remote, serverMs };
}
export function localOnlyPages(pages: Record<string, Page>, serverIds: Set<string>, isForeign: (id: string) => boolean): Page[] {
  return Object.values(pages).filter((page) => !isForeign(page.id) && !serverIds.has(page.id) && !page.isDeleted);
}
export function mergeReminders(localRems: Reminder[], rows: ReminderRow[], storeCount: number): { merged: Reminder[]; changed: boolean } {
  const tombstoned = new Set(rows.filter((r) => r.deleted_at).map((r) => r.id));
  const serverById = new Map(rows.map((r) => [r.id, r]));
  let adopted = false;
  const kept = localRems.filter((r) => !tombstoned.has(r.id)).map((r) => {
    if (serverById.get(r.id)?.notified && !r.notified) { adopted = true; return { ...r, notified: true }; }
    return r;
  });
  const haveIds = new Set(kept.map((r) => r.id));
  const incoming = rows.filter((r) => !r.deleted_at && !haveIds.has(r.id));
  const changed = incoming.length > 0 || adopted || kept.length !== storeCount;
  return { merged: changed ? [...kept, ...incoming.map(reminderFromRow)] : kept, changed };
}
