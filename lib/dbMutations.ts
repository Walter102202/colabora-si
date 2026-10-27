import { createBlock, createPage, createProperty, newId } from "@/lib/factories";
import { cloneWithNewIds, touch } from "@/lib/pageMutations";
import type { Database, DbProperty, DbRow, DbView, Page } from "@/lib/types";

function withDatabase(page: Page, database: Database, now: number): Page {
  return touch({ ...page, database }, now);
}

export function addRow(page: Page, patch: Partial<DbRow> = {}, ids: () => string = newId, now = Date.now()): { page: Page; rowId: string; rowPage: Page } | null {
  if (!page.database) return null;
  const rowPage = createPage({ id: ids(), parentId: page.id, icon: "📄", createdAt: now, updatedAt: now });
  const row: DbRow = { id: ids(), pageId: rowPage.id, ...patch, cells: { ...patch.cells } };
  rowPage.id = row.pageId;
  rowPage.title = String(row.cells.title ?? "");
  const properties = page.database.properties.map((prop) => {
    if (prop.type !== "id") return prop;
    const next = prop.nextId ?? Math.max(0, ...page.database!.rows.map((r) => Number(r.cells[prop.id]) || 0)) + 1;
    row.cells[prop.id] = next;
    return { ...prop, nextId: next + 1 };
  });
  return { page: withDatabase(page, { ...page.database, properties, rows: [...page.database.rows, row] }, now), rowId: row.id, rowPage };
}

export function updateCell(page: Page, rowId: string, propertyId: string, value: unknown, now = Date.now()): { page: Page; rowPagePatch?: { title: string } } {
  if (!page.database || !page.database.rows.some((row) => row.id === rowId)) return { page };
  const rows = page.database.rows.map((row) => row.id === rowId ? { ...row, cells: { ...row.cells, [propertyId]: value } } : row);
  return { page: withDatabase(page, { ...page.database, rows }, now), ...(propertyId === "title" ? { rowPagePatch: { title: String(value ?? "") } } : {}) };
}

export function deleteRow(page: Page, rowId: string, now = Date.now()): { page: Page; rowPageId?: string } {
  const row = page.database?.rows.find((row) => row.id === rowId);
  if (!page.database || !row) return { page };
  const rows = page.database.rows.filter((r) => r.id !== rowId).map((r) => r.parentRowId === rowId ? { ...r, parentRowId: undefined } : r);
  return { page: withDatabase(page, { ...page.database, rows }, now), rowPageId: row.pageId };
}

export function addProperty(page: Page, patch: Partial<DbProperty> = {}, now = Date.now()): Page {
  if (!page.database || page.database.locked) return page;
  const property = createProperty({ name: patch.name ?? "Property", type: patch.type ?? "text", options: patch.options, idPrefix: patch.idPrefix });
  let rows = page.database.rows;
  if (property.type === "id") {
    rows = rows.map((row, i) => ({ ...row, cells: { ...row.cells, [property.id]: i + 1 } }));
    property.nextId = rows.length + 1;
  }
  return withDatabase(page, { ...page.database, rows, properties: [...page.database.properties, property] }, now);
}

export function updateProperty(page: Page, propId: string, patch: Partial<DbProperty>, now = Date.now()): Page {
  if (!page.database || page.database.locked) return page;
  const old = page.database.properties.find((p) => p.id === propId);
  if (!old) return page;
  const toId = patch.type === "id" && old.type !== "id";
  const rows = toId ? page.database.rows.map((row, i) => ({ ...row, cells: { ...row.cells, [propId]: i + 1 } })) : page.database.rows;
  const properties = page.database.properties.map((p) => p.id === propId ? { ...p, ...patch, ...(toId ? { nextId: rows.length + 1 } : {}) } : p);
  return withDatabase(page, { ...page.database, rows, properties }, now);
}

export function deleteProperty(page: Page, propId: string, now = Date.now()): Page {
  if (!page.database || page.database.locked || propId === "title") return page;
  const rows = page.database.rows.map((row) => {
    const cells = { ...row.cells };
    delete cells[propId];
    return { ...row, cells };
  });
  return withDatabase(page, { ...page.database, rows, properties: page.database.properties.filter((p) => p.id !== propId) }, now);
}

export function addView(page: Page, patch: Partial<DbView>, now = Date.now()): Page {
  if (!page.database || page.database.locked) return page;
  const view: DbView = {
    id: newId(), name: patch.name ?? "View", type: patch.type ?? "table", groupBy: patch.groupBy,
    sorts: patch.sorts ?? [], filters: patch.filters ?? [], filterConjunction: patch.filterConjunction ?? "and",
    dateProp: patch.dateProp, endDateProp: patch.endDateProp, hiddenProps: patch.hiddenProps ?? [], aggregations: patch.aggregations ?? {},
  };
  return withDatabase(page, { ...page.database, views: [...page.database.views, view] }, now);
}

export function updateView(page: Page, viewId: string, patch: Partial<DbView>, now = Date.now()): Page {
  if (!page.database) return page;
  return withDatabase(page, { ...page.database, views: page.database.views.map((v) => v.id === viewId ? { ...v, ...patch } : v) }, now);
}

export function deleteView(page: Page, viewId: string, now = Date.now()): Page {
  if (!page.database || page.database.locked || page.database.views.length <= 1) return page;
  return withDatabase(page, { ...page.database, views: page.database.views.filter((v) => v.id !== viewId) }, now);
}

export function setDbLocked(page: Page, locked: boolean, now = Date.now()): Page {
  return page.database ? withDatabase(page, { ...page.database, locked }, now) : page;
}

export function addRowFromTemplate(page: Page, templateId: string, ids: () => string = newId, now = Date.now()): ReturnType<typeof addRow> {
  const result = addRow(page, {}, ids, now);
  const template = page.database?.rowTemplates?.find((t) => t.id === templateId);
  if (!result || !template) return result;
  const rowPage = { ...result.rowPage, blocks: template.blocks.length ? cloneWithNewIds(template.blocks, ids) : [createBlock()], icon: template.icon !== undefined ? template.icon : result.rowPage.icon };
  let next = result.page;
  for (const [key, value] of Object.entries(template.cells)) {
    if (key !== "title" && page.database?.properties.find((p) => p.id === key)?.type !== "id") next = updateCell(next, result.rowId, key, value, now).page;
  }
  return { ...result, page: next, rowPage };
}

export function saveRowAsTemplate(page: Page, rowId: string, name: string, rowPage?: Page, now = Date.now()): Page {
  const row = page.database?.rows.find((r) => r.id === rowId);
  if (!page.database || !row) return page;
  const cells = { ...row.cells };
  delete cells.title;
  for (const prop of page.database.properties) if (prop.type === "id") delete cells[prop.id];
  const template = { id: newId(), name: name.trim() || "Untitled template", icon: rowPage?.icon ?? null, cells, blocks: cloneWithNewIds(rowPage?.blocks ?? []) };
  return withDatabase(page, { ...page.database, rowTemplates: [...(page.database.rowTemplates ?? []), template] }, now);
}

export function deleteRowTemplate(page: Page, templateId: string, now = Date.now()): Page {
  return page.database ? withDatabase(page, { ...page.database, rowTemplates: (page.database.rowTemplates ?? []).filter((t) => t.id !== templateId) }, now) : page;
}
