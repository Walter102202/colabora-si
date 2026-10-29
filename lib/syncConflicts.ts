import { create } from "zustand";
import type { Block, BlockAttr, DbRow } from "@/lib/types";
import type { CellValue } from "@/lib/pageOps";
import { useStore } from "@/lib/store";
import { newId } from "@/lib/factories";

export type BlockConflict = { id: string; theirs: Block | CellValue; by?: BlockAttr; at: number; propertyId?: string; after?: string | null };
interface Conflicts {
  byPage: Record<string, BlockConflict[]>;
  pageReloads: Record<string, number>;
  notePageReload: (pageId: string) => void;
  dismissPageReload: (pageId: string) => void;
  add: (pageId: string, conflict: BlockConflict) => void;
  resolve: (pageId: string, id: string, choice: "mine" | "theirs" | "both") => void;
}
export const useBlockConflicts = create<Conflicts>((set, get) => ({
  byPage: {},
  pageReloads: {},
  notePageReload: (pageId) => set((s) => ({ pageReloads: { ...s.pageReloads, [pageId]: Date.now() } })),
  dismissPageReload: (pageId) => set((s) => { const next = { ...s.pageReloads }; delete next[pageId]; return { pageReloads: next }; }),
  add: (pageId, conflict) => set((s) => ({ byPage: { ...s.byPage, [pageId]: [...(s.byPage[pageId] ?? []).filter((c) => c.id !== conflict.id), conflict] } })),
  resolve: (pageId, id, choice) => {
    const conflict = get().byPage[pageId]?.find((c) => c.id === id), store = useStore.getState(), page = store.pages[pageId];
    if (!conflict || !page) return;
    if (choice !== "mine") {
      if (conflict.propertyId) store.updateCell(pageId, id, conflict.propertyId, conflict.theirs);
      else if (conflict.theirs && typeof conflict.theirs === "object" && "type" in conflict.theirs && "html" in conflict.theirs) {
        const block = conflict.theirs as Block;
        let found = false;
        const update = (blocks: Block[]): Block[] => blocks.flatMap((current) => {
          if (current.id === id) { found = true; return choice === "theirs" ? [{ ...block, id, rev: current.rev }] : [current, { ...block, id: newId(), rev: undefined, attr: undefined }]; }
          return [{ ...current, ...(current.columns ? { columns: current.columns.map((c) => ({ ...c, blocks: update(c.blocks) })) } : {}) }];
        });
        const blocks = update(page.blocks);
        if (found) store.setBlocks(pageId, blocks);
        else store.insertBlock(pageId, conflict.after ?? page.blocks.at(-1)?.id ?? null, { ...block, id: newId(), rev: undefined, attr: undefined });
      } else if (conflict.theirs && typeof conflict.theirs === "object" && "cells" in conflict.theirs) store.addRow(pageId, { ...(conflict.theirs as unknown as DbRow), id: newId() });
    }
    set((s) => ({ byPage: { ...s.byPage, [pageId]: (s.byPage[pageId] ?? []).filter((c) => c.id !== id) } }));
  },
}));
