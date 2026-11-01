import { useStore } from "@/lib/store";
import { isShell } from "@/lib/pageShell";
import { applyingExternal } from "@/lib/externalApply";
import { diskAvailable, flushLocalWrites, readStoredPage, storedReferrers } from "@/lib/localPersistence";
import type { Block, Page, WorkspaceState } from "@/lib/types";
import { treeIds } from "@/lib/pageMutations";
import { findBacklinks } from "@/lib/pageStats";

export type BodyState = "ready" | "unavailable";
export const opening = new Set<string>();
const inflight = new Map<string, Promise<BodyState>>();
export const PAGE_UNAVAILABLE = "This page isn't on this device yet. Connect to the internet and try again.";
export function notifyPageUnavailable(): void { window.alert(PAGE_UNAVAILABLE); }

export function ensurePageBody(id: string): Promise<BodyState> {
  const page = useStore.getState().pages[id];
  if (!page) return Promise.resolve("unavailable");
  if (!isShell(page)) return Promise.resolve("ready");
  const running = inflight.get(id); if (running) return running;
  opening.add(id);
  const task = load(id).catch((): BodyState => "unavailable").finally(() => { inflight.delete(id); opening.delete(id); });
  inflight.set(id, task); return task;
}
async function load(id: string): Promise<BodyState> {
  const initial = useStore.getState();
  const sameWorkspace = () => {
    const current = useStore.getState();
    return current.syncUserId === initial.syncUserId && current.syncWorkspaceId === initial.syncWorkspaceId && !!current.pages[id];
  };
  const stored = await readStoredPage(id);
  if (!sameWorkspace()) return "unavailable";
  const hydrate = (): BodyState => {
    if (!stored || !sameWorkspace()) return "unavailable";
    applyingExternal(() => useStore.getState().hydratePages([stored.page]));
    return isShell(useStore.getState().pages[id]) ? "unavailable" : "ready";
  };
  if (stored && !stored.stale) return hydrate();
  const { refreshPageFromCloud } = await import("@/lib/sync");
  if (!sameWorkspace()) return "unavailable";
  if (await refreshPageFromCloud(id).catch(() => false)) {
    return sameWorkspace() && !isShell(useStore.getState().pages[id]) ? "ready" : "unavailable";
  }
  return hydrate();
}
export async function ensurePageBodies(ids: string[]): Promise<BodyState> {
  const results = await Promise.all([...new Set(ids)].map(ensurePageBody));
  return results.includes("unavailable") ? "unavailable" : "ready";
}

export function databaseDeps(rootId: string, pages: Record<string, Page>): string[] {
  const seen = new Set<string>(), pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const property of pages[id]?.database?.properties ?? []) {
      if (property.type === "relation" && property.relationDbId) pending.push(property.relationDbId);
    }
  }
  return [...seen];
}

export async function backlinkIds(pageId: string): Promise<string[]> {
  await flushLocalWrites();
  if (!diskAvailable()) return findBacklinks(useStore.getState().pages, pageId).map((page) => page.id);
  const ids = await storedReferrers(pageId), pages = useStore.getState().pages;
  return ids.filter((id) => id !== pageId && pages[id] && !pages[id].isDeleted);
}

export async function duplicatePageLoaded(id: string): Promise<string | null> {
  const state = useStore.getState(), pages = state.pages, parentId = pages[id]?.parentId;
  const ids = [...treeIds(pages, id)].filter((key) => !pages[key].isDeleted);
  if (parentId && pages[parentId]?.database) ids.push(parentId);
  if (await ensurePageBodies(ids) !== "ready") { notifyPageUnavailable(); return null; }
  const current = useStore.getState();
  if (state.syncUserId !== current.syncUserId || state.syncWorkspaceId !== current.syncWorkspaceId) return null;
  return current.duplicatePage(id);
}
export async function movePageLoaded(id: string, parentId: string | null, index?: number): Promise<void> {
  const state = useStore.getState(), pages = state.pages;
  const ids = [pages[id]?.parentId, parentId].filter((key): key is string => !!key && !!pages[key]?.database);
  if (await ensurePageBodies(ids) !== "ready") throw new Error(PAGE_UNAVAILABLE);
  const current = useStore.getState();
  if (state.syncUserId !== current.syncUserId || state.syncWorkspaceId !== current.syncWorkspaceId) throw new Error(PAGE_UNAVAILABLE);
  current.movePage(id, parentId, index);
}
export async function restorePageLoaded(id: string): Promise<boolean> {
  const state = useStore.getState(), pages = state.pages, parentId = pages[id]?.parentId;
  if (parentId && pages[parentId]?.database && await ensurePageBody(parentId) !== "ready") { notifyPageUnavailable(); return false; }
  const current = useStore.getState();
  if (state.syncUserId !== current.syncUserId || state.syncWorkspaceId !== current.syncWorkspaceId || !current.pages[id]) return false;
  current.restorePage(id); return true;
}

async function preserveBodiesBeforeReplacing(ids: string[], run: () => void): Promise<boolean> {
  const before = useStore.getState();
  const ready = await ensurePageBodies(ids);
  const current = useStore.getState();
  if (before.syncUserId !== current.syncUserId || before.syncWorkspaceId !== current.syncWorkspaceId) return false;
  if (ready !== "ready") { notifyPageUnavailable(); return false; }
  try { run(); return true; }
  catch (error) {
    // A newly arrived shell may change the affected set while the original bodies load.
    if (error instanceof Error && error.message === "page_not_loaded") { notifyPageUnavailable(); return false; }
    throw error;
  }
}
export function importWorkspaceLoaded(workspace: WorkspaceState): Promise<boolean> {
  return preserveBodiesBeforeReplacing(Object.keys(useStore.getState().pages), () => useStore.getState().importWorkspace(workspace));
}
export function resetWorkspaceLoaded(): Promise<boolean> {
  return preserveBodiesBeforeReplacing(Object.keys(useStore.getState().pages), () => useStore.getState().resetWorkspace());
}
export function permanentlyDeleteLoaded(id: string): Promise<boolean> {
  return preserveBodiesBeforeReplacing([...treeIds(useStore.getState().pages, id)], () => useStore.getState().permanentlyDelete(id));
}
export function emptyTrashLoaded(): Promise<boolean> {
  return preserveBodiesBeforeReplacing(Object.values(useStore.getState().pages).filter((page) => page.isDeleted).map((page) => page.id), () => useStore.getState().emptyTrash());
}
export function exportDeps(pageId: string, pages: Record<string, Page>): string[] {
  const ids = new Set(databaseDeps(pageId, pages));
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === "database" && block.pageId) databaseDeps(block.pageId, pages).forEach((id) => ids.add(id));
      for (const column of block.columns ?? []) walk(column.blocks);
    }
  };
  walk(pages[pageId]?.blocks ?? []); return [...ids];
}
