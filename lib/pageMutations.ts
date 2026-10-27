import { createBlock, createPage, newId } from "@/lib/factories";
import type { Block, Page } from "@/lib/types";

export function touch(page: Page, now = Date.now()): Page {
  return { ...page, updatedAt: now };
}

function treeIds(pages: Record<string, Page>, id: string, deletedOnly = false): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop()!;
    if (!pages[current] || found.has(current)) continue;
    found.add(current);
    for (const page of Object.values(pages)) {
      if (page.parentId === current && (!deletedOnly || page.isDeleted)) pending.push(page.id);
    }
  }
  return found;
}

export function softDeleteTree(pages: Record<string, Page>, id: string, now: number): Record<string, Page> {
  if (!pages[id]) return pages;
  const next = { ...pages };
  for (const key of treeIds(pages, id)) next[key] = touch({ ...pages[key], isDeleted: true }, now);
  return next;
}

export function restoreTree(pages: Record<string, Page>, id: string, now: number): Record<string, Page> {
  const page = pages[id];
  if (!page) return pages;
  const next = { ...pages };
  for (const key of treeIds(pages, id, true)) next[key] = touch({ ...pages[key], isDeleted: false }, now);
  const parent = page.parentId ? pages[page.parentId] : undefined;
  if (!parent || parent.isDeleted) next[id] = { ...next[id], parentId: null };
  else if (parent.database && !parent.database.rows.some((r) => r.pageId === id)) {
    next[parent.id] = touch({ ...parent, database: { ...parent.database, rows: [...parent.database.rows, { id: newId(), pageId: id, cells: {} }] } }, now);
  }
  return next;
}

export function purgeTree(pages: Record<string, Page>, id: string): Record<string, Page> {
  if (!pages[id]) return pages;
  const next = { ...pages };
  for (const key of treeIds(pages, id)) delete next[key];
  return next;
}

export function wouldCycle(pages: Record<string, Page>, id: string, newParentId: string | null): boolean {
  const seen = new Set<string>();
  let current = newParentId;
  while (current) {
    if (current === id || seen.has(current)) return true;
    seen.add(current);
    current = pages[current]?.parentId ?? null;
  }
  return false;
}

export function moveInTree(pages: Record<string, Page>, rootOrder: string[], id: string, newParentId: string | null, index?: number): { pages: Record<string, Page>; rootOrder: string[] } {
  if (!pages[id] || wouldCycle(pages, id, newParentId)) return { pages, rootOrder };
  const order = rootOrder.filter((key) => key !== id);
  if (newParentId === null) order.splice(index ?? order.length, 0, id);
  return { pages: { ...pages, [id]: touch({ ...pages[id], parentId: newParentId }) }, rootOrder: order };
}

export function cloneWithNewIds(blocks: Block[], ids: () => string = newId): Block[] {
  return blocks.map((block) => ({
    ...block, id: ids(), rev: undefined, attr: undefined,
    ...(block.type === "synced" ? { syncedFrom: block.syncedFrom ?? block.id } : {}),
    ...(block.table ? { table: block.table.map((row) => [...row]) } : {}),
    ...(block.columns ? { columns: block.columns.map((column) => ({ ...column, id: ids(), blocks: cloneWithNewIds(column.blocks, ids) })) } : {}),
    ...(block.buttonActions ? { buttonActions: block.buttonActions.map((action) => ({ ...action, id: ids(), ...(action.kind === "insertBlocks" ? { blocks: cloneWithNewIds(action.blocks, ids) } : {}) })) } : {}),
  }));
}

export function duplicateDeep(pages: Record<string, Page>, id: string, ids: () => string = newId, now = Date.now()): { pages: Record<string, Page>; newId: string | null } {
  const page = pages[id];
  if (!page) return { pages, newId: null };
  const copy = createPage({
    ...page, id: ids(), title: page.title ? page.title + " (copy)" : "Untitled (copy)",
    isFavorite: false, updatedAt: now, comments: [], versions: [], revision: undefined,
    lastEditedBy: undefined, blocks: cloneWithNewIds(page.blocks, ids), database: undefined,
  });
  const next = { ...pages, [copy.id]: copy };
  if (page.database) {
    const database = page.database;
    const rowIds = new Map(database.rows.map((row) => [row.id, ids()]));
    const pageIds = new Map(database.rows.map((row) => [row.pageId, ids()]));
    const relations = database.properties.filter((p) => p.type === "relation" && p.relationDbId === page.id);
    const rows = database.rows.map((row) => {
      const source = pages[row.pageId];
      const rowPage = createPage({
        ...source, id: pageIds.get(row.pageId)!, parentId: copy.id, isFavorite: false,
        updatedAt: now, comments: [], versions: [], revision: undefined, lastEditedBy: undefined,
        blocks: cloneWithNewIds(source?.blocks ?? [createBlock()], ids),
      });
      next[rowPage.id] = rowPage;
      const cells = { ...row.cells };
      for (const prop of relations) {
        const links = Array.isArray(cells[prop.id]) ? cells[prop.id] as string[] : [];
        cells[prop.id] = links.map((link) => pageIds.get(link) ?? link);
      }
      return { ...row, id: rowIds.get(row.id)!, pageId: rowPage.id, parentRowId: row.parentRowId ? rowIds.get(row.parentRowId) : undefined, rev: undefined, cells };
    });
    copy.database = { ...database, id: ids(), rows, properties: database.properties.map((p) => p.type === "relation" && p.relationDbId === id ? { ...p, relationDbId: copy.id } : p) };
  }
  return { pages: next, newId: copy.id };
}
