import type { Block, BlockAttr, Database, DbProperty, DbRow, DbView, Page, PageComment, PageVersion, WorkspaceSettings, WorkspaceState } from "@/lib/types";

export type CellValue = string | number | boolean | null | CellValue[] | { [key: string]: CellValue };
export type PageScalars = Pick<Page, "title" | "icon" | "cover" | "coverPosition" | "fullWidth" | "smallText" | "locked" | "font" | "isFavorite">;
export type OpResult = { i: number; ok: boolean; rev?: number; conflict?: { id: string; theirs: Block | CellValue; by?: BlockAttr } };
export type WorkspaceOp = { op: "set_root_order"; rootOrder: string[] } | { op: "set_settings"; patch: Partial<WorkspaceSettings> } | { op: "synced_set"; key: string; blocks: Block[] | null };
export type PageOp =
  | { op: "insert_block"; after: string | null; block: Block }                 // block.id nuevo; after = id del bloque anterior, null = al principio
  | { op: "update_block"; id: string; rev?: number; patch: Partial<Block> }    // texto, indent, checked, collapsed, props del tipo
  | { op: "move_block"; id: string; after: string | null }
  | { op: "delete_block"; id: string; rev?: number }
  | { op: "set_page"; patch: Partial<PageScalars> }                             // title, icon, cover, coverPosition, fullWidth, smallText, locked, font, isFavorite
  | { op: "db_row_add"; row: DbRow; after: string | null }
  | { op: "db_row_delete"; rowId: string; rev?: number }
  | { op: "db_row_move"; rowId: string; after: string | null; parentRowId?: string | null }
  | { op: "db_cell_set"; rowId: string; propertyId: string; rev?: number; value: CellValue }
  | { op: "db_prop_set"; property: DbProperty; after?: string | null }          // alta, cambio y orden
  | { op: "db_prop_delete"; propertyId: string }
  | { op: "db_view_set"; view: DbView }
  | { op: "db_view_delete"; viewId: string }
  | { op: "comment_add"; comment: PageComment }
  | { op: "comment_set"; id: string; patch: Partial<PageComment> }             // resolved; body solo el autor
  | { op: "version_add"; version: PageVersion }                                 // cap 50 en el servidor (§II.3)
  | { op: "replace_page"; page: Page; revision: number };                       // solo personas: «Esta copia manda» y restaurar desde la papelera o una versión

const equal = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
const scalarKeys = ["title", "icon", "cover", "coverPosition", "fullWidth", "smallText", "locked", "font", "isFavorite"] as const;
function findBlock(blocks: Block[], id: string): Block | undefined {
  for (const block of blocks) {
    if (block.id === id) return block;
    for (const column of block.columns ?? []) { const found = findBlock(column.blocks, id); if (found) return found; }
  }
}
function mapBlockLists(blocks: Block[], fn: (list: Block[]) => Block[]): Block[] {
  return fn(blocks.map((block) => block.columns ? { ...block, columns: block.columns.map((c) => ({ ...c, blocks: mapBlockLists(c.blocks, fn) })) } : block));
}
function predecessors(blocks: Block[], map = new Map<string, string | null>()): Map<string, string | null> {
  blocks.forEach((block, i) => { map.set(block.id, blocks[i - 1]?.id ?? null); for (const column of block.columns ?? []) predecessors(column.blocks, map); });
  return map;
}
function insertAfter<T extends { id: string }>(list: T[], item: T, after: string | null): T[] {
  const next = list.filter((entry) => entry.id !== item.id);
  const index = after === null ? -1 : next.findIndex((entry) => entry.id === after);
  next.splice(index + 1, 0, item);
  return next;
}
function blockPatch(before: Block, after: Block): Partial<Block> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "id" || key === "rev" || key === "attr") continue;
    if (!equal(before[key as keyof Block], after[key as keyof Block])) patch[key] = after[key as keyof Block];
  }
  return patch as Partial<Block>;
}
function diffBlocks(before: Block[], after: Block[]): PageOp[] {
  const ops: PageOp[] = [];
  const ids = new Set(after.map((b) => b.id));
  for (const block of before) if (!ids.has(block.id)) ops.push({ op: "delete_block", id: block.id, rev: block.rev });
  const order = before.filter((b) => ids.has(b.id)).map((b) => b.id);
  for (const [i, block] of after.entries()) {
    const old = before.find((b) => b.id === block.id), previous = after[i - 1]?.id ?? null;
    if (!old) { ops.push({ op: "insert_block", after: previous, block }); order.splice(i, 0, block.id); continue; }
    if (order[i] !== block.id) { ops.push({ op: "move_block", id: block.id, after: previous }); order.splice(order.indexOf(block.id), 1); order.splice(i, 0, block.id); }
    const patch = blockPatch(old, block);
    if (old.columns && block.columns && equal(old.columns.map((c) => [c.id, c.width, c.blocks.map((b) => b.id)]), block.columns.map((c) => [c.id, c.width, c.blocks.map((b) => b.id)]))) {
      delete patch.columns;
      for (let c = 0; c < block.columns.length; c++) ops.push(...diffBlocks(old.columns[c].blocks, block.columns[c].blocks));
    }
    if (Object.keys(patch).length) ops.push({ op: "update_block", id: block.id, rev: old.rev, patch });
  }
  return ops;
}
function databaseChange(page: Page, fn: (database: Database) => Database): Page {
  return page.database ? { ...page, database: fn(page.database) } : page;
}

export function applyOps(input: Page, ops: PageOp[], actor: BlockAttr): { page: Page; results: OpResult[]; inverse: PageOp[] } {
  let page = input;
  const results: OpResult[] = [], inverse: PageOp[] = [];
  const previous = predecessors(input.blocks);
  const anchor = (id: string | null): string | null => {
    const seen = new Set<string>();
    while (id && !findBlock(page.blocks, id)) {
      if (seen.has(id)) return null;
      seen.add(id); id = previous.get(id) ?? null;
    }
    return id;
  };
  for (const [i, op] of ops.entries()) {
    const before = page;
    const result: OpResult = { i, ok: true };
    const block = "id" in op ? findBlock(page.blocks, op.id) : undefined;
    const row = "rowId" in op ? page.database?.rows.find((r) => r.id === op.rowId) : undefined;
    if ("rev" in op && op.rev !== undefined) {
      const current = block ?? row;
      if (current && op.rev < (current.rev ?? 0)) result.conflict = {
        id: current.id,
        theirs: op.op === "db_cell_set" ? (row!.cells[op.propertyId] ?? null) as CellValue : block ?? current as unknown as CellValue,
        ...(block?.attr ? { by: block.attr } : {}),
      };
    }
    const reviseBlock = (patch: Partial<Block>) => {
      if (!block) { result.ok = false; return; }
      result.rev = (block.rev ?? 0) + 1;
      page = { ...page, blocks: mapBlockLists(page.blocks, (list) => list.map((b) => b.id === block.id ? { ...b, ...patch, id: b.id, rev: result.rev, attr: actor } : b)) };
    };
    const reviseRow = (fn: (r: DbRow) => DbRow) => {
      if (!row) { result.ok = false; return; }
      result.rev = (row.rev ?? 0) + 1;
      page = databaseChange(page, (database) => ({ ...database, rows: database.rows.map((r) => r.id === row.id ? { ...fn(r), rev: result.rev, lastEditedBy: actor.id } : r) }));
    };
    switch (op.op) {
      case "insert_block": {
        const after = anchor(op.after), value = { ...op.block, rev: (op.block.rev ?? 0) + 1, attr: actor };
        previous.set(value.id, after);
        let inserted = false;
        let blocks = mapBlockLists(page.blocks, (list) => {
          if (after && list.some((b) => b.id === after)) { inserted = true; return insertAfter(list, value, after); }
          return list;
        });
        if (!inserted) blocks = insertAfter(blocks, value, null);
        page = { ...page, blocks }; result.rev = value.rev; break;
      }
      case "update_block": reviseBlock(op.patch); break;
      case "delete_block":
        if (!block) { result.ok = false; break; }
        result.rev = (block.rev ?? 0) + 1;
        page = { ...page, blocks: mapBlockLists(page.blocks, (list) => list.filter((b) => b.id !== op.id)) }; break;
      case "move_block": {
        if (!block || op.after === block.id) { result.ok = false; break; }
        const after = anchor(op.after), moved = { ...block, rev: (block.rev ?? 0) + 1, attr: actor };
        let inserted = false;
        let blocks = mapBlockLists(page.blocks, (list) => list.filter((b) => b.id !== op.id));
        blocks = mapBlockLists(blocks, (list) => {
          if (after && list.some((b) => b.id === after)) { inserted = true; return insertAfter(list, moved, after); }
          return list;
        });
        if (!inserted) blocks = insertAfter(blocks, moved, null);
        page = { ...page, blocks }; result.rev = moved.rev; break;
      }
      case "set_page": {
        const patch: Partial<PageScalars> = {};
        for (const key of scalarKeys) if (key in op.patch) Object.assign(patch, { [key]: op.patch[key] });
        page = { ...page, ...patch }; break;
      }
      case "db_row_add":
        page = databaseChange(page, (database) => ({ ...database, rows: insertAfter(database.rows, { ...op.row, rev: (op.row.rev ?? 0) + 1, createdBy: op.row.createdBy ?? actor.id, lastEditedBy: actor.id }, op.after) }));
        result.rev = (op.row.rev ?? 0) + 1; break;
      case "db_row_delete":
        if (!row) { result.ok = false; break; }
        result.rev = (row.rev ?? 0) + 1;
        page = databaseChange(page, (database) => ({ ...database, rows: database.rows.filter((r) => r.id !== op.rowId).map((r) => r.parentRowId === op.rowId ? { ...r, parentRowId: undefined } : r) })); break;
      case "db_row_move":
        if (!row) { result.ok = false; break; }
        result.rev = (row.rev ?? 0) + 1;
        page = databaseChange(page, (database) => ({ ...database, rows: insertAfter(database.rows, { ...row, ...("parentRowId" in op ? { parentRowId: op.parentRowId } : {}), rev: result.rev, lastEditedBy: actor.id }, op.after) })); break;
      case "db_cell_set": reviseRow((r) => ({ ...r, cells: { ...r.cells, [op.propertyId]: op.value } })); break;
      case "db_prop_set":
        page = databaseChange(page, (database) => ({ ...database, properties: "after" in op ? insertAfter(database.properties, op.property, op.after ?? null) : database.properties.some((p) => p.id === op.property.id) ? database.properties.map((p) => p.id === op.property.id ? op.property : p) : [...database.properties, op.property] })); break;
      case "db_prop_delete":
        page = databaseChange(page, (database) => ({ ...database, properties: database.properties.filter((p) => p.id !== op.propertyId), rows: database.rows.map((r) => { const cells = { ...r.cells }; delete cells[op.propertyId]; return { ...r, cells }; }) })); break;
      case "db_view_set":
        page = databaseChange(page, (database) => ({ ...database, views: database.views.some((v) => v.id === op.view.id) ? database.views.map((v) => v.id === op.view.id ? op.view : v) : [...database.views, op.view] })); break;
      case "db_view_delete": page = databaseChange(page, (database) => ({ ...database, views: database.views.filter((v) => v.id !== op.viewId) })); break;
      case "comment_add": page = { ...page, comments: [...(page.comments ?? []).filter((c) => c.id !== op.comment.id), op.comment] }; break;
      case "comment_set": page = { ...page, comments: (page.comments ?? []).map((c) => c.id === op.id ? { ...c, ...op.patch, id: c.id } : c) }; break;
      case "version_add": page = { ...page, versions: [op.version, ...(page.versions ?? []).filter((v) => v.id !== op.version.id)].slice(0, 50) }; break;
      case "replace_page": page = { ...op.page, id: input.id }; break;
    }
    if (page !== before) inverse.unshift(...diffPageToOps(page, before));
    results.push(result);
  }
  return { page, results, inverse };
}

export function diffPageToOps(prev: Page, next: Page): PageOp[] {
  if (prev === next) return [];
  const replacement = (): PageOp[] => [{ op: "replace_page", page: next, revision: prev.revision ?? 0 }];
  if (next.versions?.[0] !== prev.versions?.[0] && prev.versions?.some((version) => version.id === next.versions?.[0]?.id)) return replacement();
  if (prev.parentId !== next.parentId || prev.isDeleted !== next.isDeleted || !!prev.database !== !!next.database) return replacement();
  if (prev.database && next.database && (prev.database.id !== next.database.id || prev.database.locked !== next.database.locked || !equal(prev.database.rowTemplates, next.database.rowTemplates))) return replacement();
  if ((prev.comments ?? []).some((c) => !(next.comments ?? []).some((n) => n.id === c.id))) return replacement();
  if ((prev.versions ?? []).some((v) => !(next.versions ?? []).some((n) => n.id === v.id)) && (next.versions?.length ?? 0) < 50) return replacement();
  const ops: PageOp[] = [];
  const patch: Partial<PageScalars> = {};
  for (const key of scalarKeys) if (!equal(prev[key], next[key])) Object.assign(patch, { [key]: next[key] });
  if (Object.keys(patch).length) ops.push({ op: "set_page", patch });
  ops.push(...diffBlocks(prev.blocks, next.blocks));
  if (prev.database && next.database) {
    const before = prev.database, after = next.database;
    for (const prop of before.properties) if (!after.properties.some((p) => p.id === prop.id)) ops.push({ op: "db_prop_delete", propertyId: prop.id });
    for (const [i, prop] of after.properties.entries()) {
      const old = before.properties.find((p) => p.id === prop.id);
      if (!equal(old, prop) || before.properties[i]?.id !== prop.id) ops.push({ op: "db_prop_set", property: prop, after: after.properties[i - 1]?.id ?? null });
    }
    for (const view of before.views) if (!after.views.some((v) => v.id === view.id)) ops.push({ op: "db_view_delete", viewId: view.id });
    for (const view of after.views) if (!equal(before.views.find((v) => v.id === view.id), view)) ops.push({ op: "db_view_set", view });
    const rows = before.rows.filter((r) => after.rows.some((n) => n.id === r.id)).map((r) => r.id);
    for (const row of before.rows) if (!after.rows.some((r) => r.id === row.id)) ops.push({ op: "db_row_delete", rowId: row.id, rev: row.rev });
    for (const [i, row] of after.rows.entries()) {
      const old = before.rows.find((r) => r.id === row.id), previous = after.rows[i - 1]?.id ?? null;
      if (!old) { ops.push({ op: "db_row_add", row, after: previous }); rows.splice(i, 0, row.id); continue; }
      if (old.pageId !== row.pageId) return replacement();
      if (rows[i] !== row.id || old.parentRowId !== row.parentRowId) {
        ops.push({ op: "db_row_move", rowId: row.id, after: previous, parentRowId: row.parentRowId }); rows.splice(rows.indexOf(row.id), 1); rows.splice(i, 0, row.id);
      }
      if (Object.keys(old.cells).some((key) => !(key in row.cells) && after.properties.some((p) => p.id === key))) return replacement();
      for (const [propertyId, value] of Object.entries(row.cells)) if (!equal(old.cells[propertyId], value)) ops.push({ op: "db_cell_set", rowId: row.id, propertyId, rev: old.rev, value: value as CellValue });
    }
  }
  for (const comment of next.comments ?? []) {
    const old = prev.comments?.find((c) => c.id === comment.id);
    if (!old) ops.push({ op: "comment_add", comment });
    else if (!equal(old, comment)) ops.push({ op: "comment_set", id: comment.id, patch: comment });
  }
  for (const version of [...(next.versions ?? [])].reverse()) if (!prev.versions?.some((v) => equal(v, version))) ops.push({ op: "version_add", version });
  return ops;
}
export function invertOps(page: Page, ops: PageOp[]): PageOp[] {
  return applyOps(page, ops, { by: "human", id: "local", at: page.updatedAt }).inverse;
}
export function applyWorkspaceOps(workspace: WorkspaceState, ops: WorkspaceOp[]): WorkspaceState {
  let next = workspace;
  for (const op of ops) {
    if (op.op === "set_root_order") next = { ...next, rootOrder: [...op.rootOrder] };
    else if (op.op === "set_settings") next = { ...next, settings: { ...next.settings, ...op.patch } as WorkspaceSettings };
    else { const syncedBlocks = { ...next.syncedBlocks }; if (op.blocks === null) delete syncedBlocks[op.key]; else syncedBlocks[op.key] = op.blocks; next = { ...next, syncedBlocks }; }
  }
  return next;
}
