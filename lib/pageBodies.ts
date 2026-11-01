import { useStore } from "@/lib/store";
import { isShell } from "@/lib/pageShell";
import { applyingExternal } from "@/lib/externalApply";
import { diskAvailable, flushLocalWrites, readStoredPage, storedReferrers } from "@/lib/localPersistence";
import type { Page } from "@/lib/types";
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
