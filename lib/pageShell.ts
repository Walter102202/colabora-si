import type { Block, Database, DbRow, Page, PageComment, PageVersion, RowTemplate } from "@/lib/types";

const UNLOADED = Symbol("colabora.unloadedBody");
type Marked = Page & { [UNLOADED]?: true };
const PAGE_LINK = /\/p\/([^/?#"'<>\s)]+)/g;

export type DatabaseHead = Pick<Database, "id" | "properties" | "views" | "locked">;
export type PageMeta = Omit<Page, "blocks" | "database" | "comments" | "versions"> & {
  database?: DatabaseHead;
  bodyRev: number | null;
  links: string[];
};
export interface PageBody {
  id: string;
  blocks: Block[];
  rows?: DbRow[];
  rowTemplates?: RowTemplate[];
  comments?: PageComment[];
  versions?: PageVersion[];
}

export function isShell(page: Page | null | undefined): boolean {
  return !!page && !!(page as Marked)[UNLOADED];
}

export function pageReferences(page: Page): string[] {
  const found = new Set<string>();
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if ((block.type === "page" || block.type === "database") && block.pageId) found.add(block.pageId);
      for (const match of block.html?.matchAll(PAGE_LINK) ?? []) found.add(match[1]);
      for (const column of block.columns ?? []) walk(column.blocks);
    }
  };
  walk(page.blocks);
  if (page.database) {
    for (const property of page.database.properties) if (property.type === "relation") {
      for (const row of page.database.rows) {
        const ids = row.cells[property.id];
        if (Array.isArray(ids)) for (const id of ids) found.add(String(id));
      }
    }
  }
  found.delete(page.id);
  return [...found];
}

export function splitPage(page: Page): { meta: PageMeta; body: PageBody } {
  if (isShell(page)) throw new Error("shell_has_no_body");
  const { blocks, database, comments, versions, ...rest } = page;
  const { rows, rowTemplates, ...head } = database ?? ({} as Partial<Database>);
  return {
    meta: { ...rest, ...(database ? { database: head as DatabaseHead } : {}), bodyRev: page.revision ?? 0, links: pageReferences(page) },
    body: { id: page.id, blocks, ...(database ? { rows, rowTemplates } : {}), comments, versions },
  };
}

export function joinPage(meta: PageMeta, body: PageBody): Page {
  const { bodyRev, links, database, ...rest } = meta;
  void links;
  return {
    ...rest, blocks: body.blocks, comments: body.comments, versions: body.versions,
    ...(database ? { database: { ...database, rows: body.rows ?? [], rowTemplates: body.rowTemplates } } : {}),
    revision: bodyRev === 0 && rest.revision === undefined ? undefined : bodyRev ?? undefined,
  };
}

export function shellFromMeta(meta: PageMeta): Page {
  const { bodyRev, links, database, ...rest } = meta;
  void bodyRev; void links;
  return { ...rest, blocks: [], ...(database ? { database: { ...database, rows: [] } } : {}), [UNLOADED]: true } as Page;
}

export function shellOf(page: Page): Page { return shellFromMeta(splitPage(page).meta); }

// Use current metadata without mistaking an unloaded body's empty arrays for content.
export function overlayMeta(full: Page, shell: Page): Page {
  const { blocks, database, comments, versions, [UNLOADED]: unloaded, ...meta } = shell as Marked;
  void blocks; void comments; void versions; void unloaded;
  const head = database && full.database ? { ...full.database, id: database.id, properties: database.properties, views: database.views, locked: database.locked } : full.database;
  // Restoring an archived row removes rowOrigin; spreading alone would resurrect it.
  return { ...full, ...meta, rowOrigin: meta.rowOrigin, database: head, revision: full.revision };
}
