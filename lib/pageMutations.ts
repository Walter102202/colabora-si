import { createPage, newId } from "@/lib/factories";
import type { Block, DbRow, Page } from "@/lib/types";

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
  detachRow(next, id, now);
  return next;
}

function detachRow(pages: Record<string, Page>, id: string, now: number): void {
  const page = pages[id], parent = pages[page.parentId ?? ""], database = parent?.database;
  const index = database?.rows.findIndex((r) => r.pageId === id) ?? -1;
  if (!database || index < 0 || parent.isDeleted) return;
  const row = database.rows[index];
  pages[id] = { ...page, rowOrigin: { databasePageId: parent.id, row, index } };
  pages[parent.id] = touch({ ...parent, database: { ...database, rows: database.rows.filter((r) => r.id !== row.id).map((r) => r.parentRowId === row.id ? { ...r, parentRowId: undefined } : r) } }, now);
}

export function restoreTree(pages: Record<string, Page>, id: string, now: number): Record<string, Page> {
  const page = pages[id];
  if (!page) return pages;
  const next = { ...pages };
  for (const key of treeIds(pages, id, true)) next[key] = touch({ ...pages[key], isDeleted: false }, now);
  const parent = page.parentId ? pages[page.parentId] : undefined;
  if (!parent || parent.isDeleted) next[id] = { ...next[id], parentId: null };
  else if (parent.database && !parent.database.rows.some((r) => r.pageId === id)) {
    const saved = page.rowOrigin?.databasePageId === parent.id ? page.rowOrigin : undefined;
    const rows = [...parent.database.rows], row = saved?.row ?? { id: newId(), pageId: id, cells: {} };
    rows.splice(saved?.index ?? rows.length, 0, { ...row, rev: undefined, cells: { ...row.cells, title: page.title }, parentRowId: rows.some((r) => r.id === row.parentRowId) ? row.parentRowId : undefined });
    next[parent.id] = touch({ ...parent, database: { ...parent.database, rows } }, now);
    next[id] = { ...next[id], rowOrigin: undefined };
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
  if (newParentId && (!pages[newParentId] || pages[newParentId].isDeleted)) return { pages, rootOrder };
  const source = pages[pages[id].parentId ?? ""], destination = pages[newParentId ?? ""];
  if (pages[id].locked || source?.locked || destination?.locked) throw new Error("Unlock the page before moving it.");
  if (pages[id].parentId === newParentId && newParentId !== null) return { pages, rootOrder };
  const next = { ...pages }, now = Date.now();
  detachRow(next, id, now);
  const saved = next[id].rowOrigin;
  if (destination?.database) {
    const database = destination.database, origin = pages[saved?.databasePageId ?? ""]?.database;
    const cells: DbRow["cells"] = { title: pages[id].title };
    let properties = database.properties;
    for (const [key, value] of Object.entries(saved?.row.cells ?? {})) {
      if (key === "title" || value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
      const prop = origin?.properties.find((p) => p.id === key);
      const target = properties.find((p) => p.id === key) ?? properties.find((p) => p.name === prop?.name && p.type === prop?.type);
      if (!target || (prop && target.type !== prop.type)) throw new Error(`The destination needs a matching “${prop?.name ?? key}” property to keep this row's data.`);
      if (prop?.type === "relation" && prop.relationDbId !== target.relationDbId) throw new Error(`“${prop.name}” must relate to the same database in the destination.`);
      if (prop?.options && target.options && prop.id !== target.id) {
        const options = [...target.options];
        const translate = (id: unknown) => { const option = prop.options!.find((o) => o.id === id); if (!option) return id; let match = options.find((o) => o.name === option.name); if (!match) { match = { ...option, id: newId() }; options.push(match); } return match.id; };
        cells[target.id] = Array.isArray(value) ? value.map(translate) : translate(value);
        properties = properties.map((p) => p.id === target.id ? { ...p, options } : p);
      } else cells[target.id] = value;
    }
    properties = properties.map((prop) => {
      if (prop.type !== "id") return prop;
      const value = Math.max(prop.nextId ?? 1, ...database.rows.map((r) => (Number(r.cells[prop.id]) || 0) + 1));
      if (saved?.databasePageId !== destination.id || !Number.isFinite(Number(cells[prop.id])) || cells[prop.id] == null || database.rows.some((r) => r.cells[prop.id] === cells[prop.id])) cells[prop.id] = value;
      return { ...prop, nextId: Math.max(value, Number(cells[prop.id]) + 1) };
    });
    const row: DbRow = { id: saved?.row.id ?? newId(), pageId: id, cells };
    const rows = [...database.rows]; rows.splice(index ?? rows.length, 0, row);
    next[destination.id] = touch({ ...destination, database: { ...database, rows, properties } }, now);
    next[id] = { ...next[id], rowOrigin: undefined };
  }
  const order = rootOrder.filter((key) => key !== id);
  if (newParentId === null) order.splice(index ?? order.length, 0, id);
  next[id] = touch({ ...next[id], parentId: newParentId }, now);
  return { pages: next, rootOrder: order };
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
  if (!pages[id] || pages[id].isDeleted) return { pages, newId: null };
  const originals = [...treeIds(pages, id)].filter((key) => !pages[key].isDeleted);
  const pageIds = new Map(originals.map((key) => [key, ids()]));
  const next = { ...pages };
  const remap = (blocks: Block[]): Block[] => blocks.map((block) => ({ ...block,
    ...(block.pageId && !(block.type === "database" && block.linkedViews) ? { pageId: pageIds.get(block.pageId) ?? block.pageId } : {}),
    ...(block.columns ? { columns: block.columns.map((c) => ({ ...c, blocks: remap(c.blocks) })) } : {}),
    ...(block.buttonActions ? { buttonActions: block.buttonActions.map((a) => a.kind === "openPage" && a.pageId ? { ...a, pageId: pageIds.get(a.pageId) ?? a.pageId } : a.kind === "insertBlocks" ? { ...a, blocks: remap(a.blocks) } : a) } : {}) }));
  const copyBlocks = (blocks: Block[]) => remap(cloneWithNewIds(blocks, ids));
  for (const key of originals) {
    const page = pages[key];
    const copy = createPage({ ...page, id: pageIds.get(key)!, parentId: key === id ? page.parentId : pageIds.get(page.parentId!) ?? page.parentId,
      title: key === id ? (page.title || "Untitled") + " (copy)" : page.title, createdAt: now, updatedAt: now,
      isFavorite: false, rowOrigin: undefined, comments: [], versions: [], revision: undefined, lastEditedBy: undefined,
      blocks: copyBlocks(page.blocks), database: undefined });
    if (page.database) {
      const database = structuredClone(page.database), rowIds = new Map(database.rows.map((row) => [row.id, ids()]));
      copy.database = { ...database, id: ids(), properties: database.properties.map((prop) => ({ ...prop,
        ...(prop.relationDbId ? { relationDbId: pageIds.get(prop.relationDbId) ?? prop.relationDbId } : {}) })),
        rows: database.rows.filter((row) => pageIds.has(row.pageId)).map((row) => ({ ...row, id: rowIds.get(row.id)!, pageId: pageIds.get(row.pageId)!,
          parentRowId: row.parentRowId ? rowIds.get(row.parentRowId) : undefined, rev: undefined, createdBy: undefined, lastEditedBy: undefined,
          cells: Object.fromEntries(Object.entries(row.cells).map(([propId, value]) => [propId,
            database.properties.some((p) => p.id === propId && p.type === "relation") && Array.isArray(value) ? value.map((link) => pageIds.get(link) ?? link) : value])) })),
        rowTemplates: database.rowTemplates?.map((template) => ({ ...template, id: ids(), blocks: copyBlocks(template.blocks) })) };
    }
    next[copy.id] = copy;
  }
  const copyId = pageIds.get(id)!, parent = next[pages[id].parentId ?? ""], originalRow = parent?.database?.rows.find((row) => row.pageId === id);
  if (parent?.database && originalRow) {
    const row: DbRow = { ...structuredClone(originalRow), id: ids(), pageId: copyId, rev: undefined, cells: { ...structuredClone(originalRow.cells), title: next[copyId].title } };
    const properties = parent.database.properties.map((p) => { if (p.type !== "id") return p; const n = p.nextId ?? Math.max(0, ...parent.database!.rows.map((r) => Number(r.cells[p.id]) || 0)) + 1; row.cells[p.id] = n; return { ...p, nextId: n + 1 }; });
    next[parent.id] = touch({ ...parent, database: { ...parent.database, properties, rows: [...parent.database.rows, row] } }, now);
  }
  return { pages: next, newId: copyId };
}
