import { create } from "zustand";
import type { Block, BlockAttr, DbRow, Page } from "@/lib/types";
import type { CellValue } from "@/lib/pageOps";
import { useStore } from "@/lib/store";
import { newId } from "@/lib/factories";
import { isShell } from "@/lib/pageShell";
import { ensurePageBody, notifyPageUnavailable } from "@/lib/pageBodies";

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
    if (isShell(page)) {
      void ensurePageBody(pageId).then((result) => {
        if (result === "ready" && !isShell(useStore.getState().pages[pageId])) get().resolve(pageId, id, choice);
        else notifyPageUnavailable();
      });
      return;
    }
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

export interface PageRecovery { id: string; at: number; page: Page }
const recoveryKey = (userId: string, pageId: string) => `colabora-recovery:${userId}:${pageId}`;
export const usePageRecoveries = create<{ copies: Record<string, PageRecovery[]>; errors: Record<string, string> }>(() => ({ copies: {}, errors: {} }));
export function loadPageRecoveries(userId: string, pageId: string): void {
  const key = recoveryKey(userId, pageId);
  try {
    const copies = JSON.parse(localStorage.getItem(key) ?? "[]") as PageRecovery[];
    usePageRecoveries.setState((s) => ({ copies: { ...s.copies, [key]: copies }, errors: { ...s.errors, [key]: "" } }));
  } catch { usePageRecoveries.setState((s) => ({ errors: { ...s.errors, [key]: "Could not read the saved local copy." } })); }
}
export function pageRecoveryCopies(userId: string, pageId: string): PageRecovery[] | undefined {
  return usePageRecoveries.getState().copies[recoveryKey(userId, pageId)];
}
export function savePageRecovery(userId: string, page: Page): void {
  if (isShell(page)) { useBlockConflicts.getState().notePageReload(page.id); return; }
  const key = recoveryKey(userId, page.id);
  const copies = JSON.parse(localStorage.getItem(key) ?? "[]") as PageRecovery[];
  const next = [...copies, { id: crypto.randomUUID(), at: Date.now(), page }];
  // A storage failure leaves the queue intact, so it cannot silently discard this work.
  localStorage.setItem(key, JSON.stringify(next));
  usePageRecoveries.setState((s) => ({ copies: { ...s.copies, [key]: next } }));
  useBlockConflicts.getState().notePageReload(page.id);
}
export function dismissPageRecovery(userId: string, pageId: string, id: string): void {
  const key = recoveryKey(userId, pageId);
  const next = (JSON.parse(localStorage.getItem(key) ?? "[]") as PageRecovery[]).filter((copy) => copy.id !== id);
  if (next.length) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key);
  usePageRecoveries.setState((s) => ({ copies: { ...s.copies, [key]: next } }));
}
