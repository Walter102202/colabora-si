import { create } from "zustand";
import type { Block, BlockAttr, DbRow } from "@/lib/types";
import type { CellValue } from "@/lib/pageOps";
import { useStore } from "@/lib/store";
import { newId } from "@/lib/factories";

export type BlockConflict = { id: string; theirs: Block | CellValue; by?: BlockAttr; at: number; propertyId?: string; after?: string | null };
interface Conflicts {
  byPage: Record<string, BlockConflict[]>;
  add: (pageId: string, conflict: BlockConflict) => void;
  resolve: (pageId: string, id: string, choice: "mine" | "theirs" | "both") => void;
}
export const useBlockConflicts = create<Conflicts>((set, get) => ({
  byPage: {},
  add: (pageId, conflict) => set((s) => ({ byPage: { ...s.byPage, [pageId]: [...(s.byPage[pageId] ?? []).filter((c) => c.id !== conflict.id), conflict] } })),
  resolve: (pageId, id, choice) => {
    const conflict = get().byPage[pageId]?.find((c) => c.id === id), store = useStore.getState(), page = store.pages[pageId];
    if (!conflict || !page) return;
    if (choice !== "mine") {
      if (conflict.propertyId) store.updateCell(pageId, id, conflict.propertyId, conflict.theirs);
      else if (conflict.theirs && typeof conflict.theirs === "object" && "type" in conflict.theirs && "html" in conflict.theirs) {
        const block = conflict.theirs as Block;
        const exists = JSON.stringify(page.blocks).includes(`"id":"${id}"`);
        if (choice === "theirs" && exists) store.updateBlock(pageId, id, block);
        else store.insertBlock(pageId, exists ? id : conflict.after ?? page.blocks.at(-1)?.id ?? null, { ...block, id: newId(), rev: undefined, attr: undefined });
      } else if (conflict.theirs && typeof conflict.theirs === "object" && "cells" in conflict.theirs) store.addRow(pageId, { ...(conflict.theirs as unknown as DbRow), id: newId() });
    }
    set((s) => ({ byPage: { ...s.byPage, [pageId]: (s.byPage[pageId] ?? []).filter((c) => c.id !== id) } }));
  },
}));
