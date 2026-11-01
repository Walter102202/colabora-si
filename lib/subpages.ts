import { getChildren } from "@/lib/store";
import type { Block, Page } from "@/lib/types";

function linkedPages(blocks: Block[], linked = new Set<string>()): Set<string> {
  for (const block of blocks) {
    if (block.pageId) linked.add(block.pageId);
    for (const column of block.columns ?? []) linkedPages(column.blocks, linked);
  }
  return linked;
}

// Child pages the body does not link. Only the /page block writes a link, so a page moved in, added from the sidebar
// or created by an agent would otherwise appear in the sidebar and nowhere in its parent.
export function unlinkedSubpages(page: Page, pages: Record<string, Page>): Page[] {
  if (page.database) return [];
  const linked = linkedPages(page.blocks);
  return getChildren(pages, page.id).filter((child) => !linked.has(child.id));
}
