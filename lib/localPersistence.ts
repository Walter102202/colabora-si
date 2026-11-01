import { useStore, type Store } from "@/lib/store";
import type { Page } from "@/lib/types";
import { foreignPageIds } from "@/lib/foreignPages";
import { isApplyingExternal } from "@/lib/externalApply";
import { isShell, overlayMeta, splitPage } from "@/lib/pageShell";
import { writeBatch, type PageWrite } from "@/lib/localDb";
import { searchRecord } from "@/lib/search";

const WRITE_DELAY_MS = 300, WRITE_CHUNK = 200, MAX_RETRY_MS = 30_000;
const KV_KEYS = ["rootOrder", "expanded", "syncedBlocks", "reminders", "settings"] as const;
let db: IDBDatabase | null = null, epoch = "", generation = 0;
let unsubscribe: (() => void) | null = null, removeListeners: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null, flushing: Promise<void> | null = null, retryMs = 1000;
const dirtyPages = new Map<string, Page | null>(), remotePages = new Set<string>(), dirtyKv = new Map<string, unknown>();

export function diskAvailable(): boolean { return db !== null; }
export function hasPendingLocalWrites(): boolean { return dirtyPages.size > 0 || dirtyKv.size > 0 || flushing !== null; }
export function fullWrite(page: Page, remote = false): PageWrite {
  return { kind: "full", id: page.id, ...splitPage(page), search: searchRecord(page, useStore.getState().syncedBlocks ?? {}), remote };
}

function schedule(delay = WRITE_DELAY_MS): void {
  if (!db || timer !== null) return;
  timer = setTimeout(() => { timer = null; void flushLocalWrites().catch(() => {}); }, delay);
}
function markPage(id: string, page: Page | null): void {
  if (foreignPageIds.has(id)) return;
  const pending = dirtyPages.get(id);
  // A downloaded body must survive a newer metadata-only update in the same window.
  dirtyPages.set(id, page && pending && isShell(page) && !isShell(pending) ? overlayMeta(pending, page) : page);
  schedule();
}
function onStoreChange(state: Store, prev: Store): void {
  if (state.pages !== prev.pages) {
    for (const id in state.pages) {
      const before = prev.pages[id], after = state.pages[id];
      if (before === after) continue;
      if (before && isShell(before) !== isShell(after) && isApplyingExternal()) continue;
      remotePages.delete(id);
      markPage(id, after);
    }
    for (const id in prev.pages) if (!state.pages[id]) { remotePages.delete(id); markPage(id, null); }
  }
  for (const key of KV_KEYS) if (state[key] !== prev[key]) { dirtyKv.set(key, state[key]); schedule(); }
  if (state.syncWorkspaceId !== prev.syncWorkspaceId || state.syncUserId !== prev.syncUserId) {
    dirtyKv.set("sync", { syncWorkspaceId: state.syncWorkspaceId, syncUserId: state.syncUserId }); schedule();
  }
}

function pageWrite(id: string, page: Page | null, remote: boolean): PageWrite {
  if (!page) return { kind: "delete", id };
  if (!isShell(page)) return fullWrite(page, remote);
  const { blocks, database, comments, versions, ...rest } = page;
  void blocks; void comments; void versions;
  const { rows, rowTemplates, ...head } = database ?? {};
  void rows; void rowTemplates;
  return { kind: "meta", id, meta: { ...rest, ...(database ? { database: head as NonNullable<typeof database> } : {}) } };
}

async function writeNow(token: number, connection: IDBDatabase, currentEpoch: string): Promise<void> {
  while (token === generation && (dirtyPages.size || dirtyKv.size)) {
    const pages = [...dirtyPages].slice(0, WRITE_CHUNK), kv = [...dirtyKv];
    const remote = new Set(pages.filter(([id]) => remotePages.has(id)).map(([id]) => id));
    for (const [id] of pages) { dirtyPages.delete(id); remotePages.delete(id); }
    dirtyKv.clear();
    try {
      await writeBatch(connection, currentEpoch, { pages: pages.filter(([id]) => !foreignPageIds.has(id)).map(([id, page]) => pageWrite(id, page, remote.has(id))), kv });
      if (token === generation) retryMs = 1000;
    } catch (error) {
      if (token === generation) {
        for (const [id, page] of pages) if (!foreignPageIds.has(id)) {
          const newer = dirtyPages.get(id);
          if (!dirtyPages.has(id)) { dirtyPages.set(id, page); if (remote.has(id)) remotePages.add(id); }
          else if (page && !isShell(page) && newer && isShell(newer)) dirtyPages.set(id, overlayMeta(page, newer));
        }
        for (const [key, value] of kv) if (!dirtyKv.has(key)) dirtyKv.set(key, value);
        if (timer !== null) clearTimeout(timer);
        timer = null; schedule(retryMs); retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      }
      throw error;
    }
  }
}

export function flushLocalWrites(): Promise<void> {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (flushing) return flushing;
  if (!db || (!dirtyPages.size && !dirtyKv.size)) return Promise.resolve();
  const token = generation;
  const task = writeNow(token, db, epoch).finally(() => {
    if (flushing === task) flushing = null;
  });
  flushing = task;
  return task;
}

export function persistFull(pages: Page[]): void {
  for (const page of pages) {
    if (foreignPageIds.has(page.id)) continue;
    remotePages.add(page.id); markPage(page.id, page);
  }
}

function stopWriter(): void {
  generation++; unsubscribe?.(); unsubscribe = null; removeListeners?.(); removeListeners = null;
  if (timer !== null) clearTimeout(timer);
  timer = null; flushing = null; db = null; epoch = ""; retryMs = 1000;
  dirtyPages.clear(); remotePages.clear(); dirtyKv.clear();
}

export function startWriter(connection: IDBDatabase, currentEpoch: string): () => void {
  stopWriter(); db = connection; epoch = currentEpoch;
  const token = generation;
  unsubscribe = useStore.subscribe(onStoreChange);
  if (typeof window !== "undefined") {
    const flush = () => { void flushLocalWrites().catch(() => {}); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden);
    removeListeners = () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }
  return () => { if (token === generation) stopWriter(); };
}
