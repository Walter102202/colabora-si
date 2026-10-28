import { pageUrl } from "@/lib/routes";
import type { Block, Page } from "@/lib/types";
import { stripHtml } from "@/lib/utils";

function wordsIn(html: string): number {
  const t = stripHtml(html).trim();      // stripHtml: §II.6
  return t ? t.split(/\s+/).length : 0;
}

const NO_WORDS = new Set<Block["type"]>([
  "divider", "image", "bookmark", "toc", "database", "equation", "page",
]);

// Palabras de una página: recorre columnas; tablas celda a celda; code por
// espacios sobre el texto crudo; omite los tipos sin texto.
export function pageWordCount(blocks: Block[]): number {
  let n = 0;
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === "table") {
        for (const row of b.table ?? []) for (const c of row) n += wordsIn(c);
      } else if (b.type === "columns") {
        for (const col of b.columns ?? []) walk(col.blocks);
      } else if (b.type === "code") {
        const t = (b.html ?? "").trim();
        n += t ? t.split(/\s+/).length : 0;
      } else if (!NO_WORDS.has(b.type)) {
        n += wordsIn(b.html);
      }
    }
  };
  walk(blocks);
  return n;
}

// Bloques de una página: cuenta el bloque columns y además sus bloques interiores.
export function pageBlockCount(blocks: Block[]): number {
  let n = 0;
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      n += 1;
      if (b.type === "columns") for (const col of b.columns ?? []) walk(col.blocks);
    }
  };
  walk(blocks);
  return n;
}

// Páginas vivas (distintas de la propia) que referencian `targetId` mediante:
// bloque page o database con ese pageId; cualquier html que contenga "/p/<id>"
// (menciones y enlaces); columnas (recursivo); o una celda relation que incluya el id.
export function findBacklinks(pages: Record<string, Page>, targetId: string): Page[] {
  const out = new Set<string>();
  const needleHref = pageUrl(targetId);
  const blocksReference = (blocks: Block[]): boolean => {
    for (const b of blocks) {
      if ((b.type === "page" || b.type === "database") && b.pageId === targetId) return true;
      if (b.html && b.html.includes(needleHref)) return true;
      if (b.type === "columns" && b.columns) {
        for (const col of b.columns) if (blocksReference(col.blocks)) return true;
      }
    }
    return false;
  };
  for (const p of Object.values(pages)) {
    if (p.isDeleted || p.id === targetId) continue;
    let hit = blocksReference(p.blocks);
    if (!hit && p.database) {
      for (const row of p.database.rows) {
        for (const prop of p.database.properties) {
          if (prop.type === "relation") {
            const ids = row.cells[prop.id];
            if (Array.isArray(ids) && (ids as string[]).includes(targetId)) { hit = true; break; }
          }
        }
        if (hit) break;
      }
    }
    if (hit) out.add(p.id);
  }
  return [...out].map((id) => pages[id]).filter(Boolean);
}
export function pageStats(page: Page, pages: Record<string, Page>) {
  const words = pageWordCount(page.blocks);
  return { words, blocks: pageBlockCount(page.blocks), mins: Math.max(1, Math.round(words / 200)), backlinks: findBacklinks(pages, page.id) };
}
