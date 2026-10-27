import type { Database, DbProperty, DbRow, DbView, Page, PropertyType } from "@/lib/types";

let counter = 0;
const id = (prefix: string) => `${prefix}${++counter}`;

/** Propiedad: por defecto tipo "text" llamada "Prop". */
export function prop(patch: Partial<DbProperty> & { type?: PropertyType } = {}): DbProperty {
  return { id: id("p"), name: "Prop", type: "text", ...patch };
}

/** Fila: celdas dadas y un pageId (por defecto nuevo). */
export function row(cells: Record<string, unknown> = {}, pageId = id("pg")): DbRow {
  return { id: id("r"), pageId, cells };
}

/** Vista: tabla sin orden ni filtros. */
export function view(patch: Partial<DbView> = {}): DbView {
  return { id: id("v"), name: "Table", type: "table", sorts: [], filters: [], ...patch };
}

/** Página mínima válida; createdAt = updatedAt = 1_700_000_000_000. */
export function page(patch: Partial<Page> = {}): Page {
  const now = 1_700_000_000_000;
  return {
    id: id("pg"),
    title: "Untitled",
    icon: null,
    cover: null,
    coverPosition: 50,
    parentId: null,
    blocks: [],
    isFavorite: false,
    isDeleted: false,
    fullWidth: false,
    smallText: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

/** Base de datos con una vista tabla. */
export function db(properties: DbProperty[], rows: DbRow[] = []): Database {
  return { id: id("db"), properties, rows, views: [view()] };
}

/**
 * Base de una fila preparada para evaluar una fórmula: `props` son las
 * entradas, `expr` la fórmula. Devuelve también la página dueña de la fila.
 */
export function makeFormulaDb(
  expr: string,
  props: DbProperty[] = [],
  cells: Record<string, unknown> = {}
): { database: Database; formulaProp: DbProperty; theRow: DbRow; pages: Record<string, Page> } {
  const formulaProp = prop({ name: "F", type: "formula", formula: expr });
  const theRow = row(cells);
  const database = db([...props, formulaProp], [theRow]);
  const owner = page({ id: theRow.pageId, title: "Row page" });
  return { database, formulaProp, theRow, pages: { [owner.id]: owner } };
}

import { createBlock } from "@/lib/factories";
import type { Block, BlockType, ColumnData } from "@/lib/types";

export const b = (type: BlockType = "paragraph", patch: Partial<Block> = {}) => createBlock(type, { html: "text", ...patch });
export const column = (blocks: Block[], width?: number): ColumnData => ({ id: id("col"), blocks, ...(width === undefined ? {} : { width }) });
export const T = 1_700_000_000_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const liveRow = (pageId: string, ms: number, patch: Partial<Page> = {}) => ({
  id: pageId, data: { ...page({ id: pageId, updatedAt: ms, ...patch }), _client: "other-tab" },
  deleted_at: null, updated_at: iso(ms), revision: patch.revision ?? 1,
});
export const tombstoneRow = (pageId: string, ms: number) => ({ id: pageId, data: null, deleted_at: iso(ms), updated_at: iso(ms), revision: 1 });