import { useStore, type Store } from "@/lib/store";
import type { Page, WorkspaceState } from "@/lib/types";
import { create } from "zustand";
import { foreignPageIds } from "@/lib/foreignPages";
import { applyingExternal, isApplyingExternal } from "@/lib/externalApply";
import { isShell, joinPage, overlayMeta, splitPage } from "@/lib/pageShell";
import { claimWorkspace, countRecords, LOCAL_DB, openLocalDb, readBodies, readWorkspace, wipeLocalDb, writeBatch, type PageWrite, type StoredWorkspace } from "@/lib/localDb";
import { searchRecord } from "@/lib/search";
import { isSupabaseConfigured } from "@/lib/supabase";
import { mark, pageDataSizes, recordHydration } from "@/lib/metrics";

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

type Health = "starting" | "ok" | "full" | "failing" | "unavailable";
export const useLocalHealth = create<{ health: Health }>(() => ({ health: "starting" }));
const LEGACY_KEY = "colabora-workspace", CLEAR_PENDING_KEY = "colabora-clear-pending", OPEN_TIMEOUT_MS = 8000;
type LocalState = Pick<Store, "pages" | "rootOrder" | "expanded" | "syncedBlocks" | "reminders" | "settings" | "syncUserId" | "syncWorkspaceId">;
let hydration: Promise<void> | null = null, giveUp: (() => void) | null = null;
const setHealth = (health: Health) => useLocalHealth.setState({ health });

function currentState(): LocalState {
  const state = useStore.getState();
  return { pages: Object.fromEntries(Object.entries(state.pages).filter(([id]) => !foreignPageIds.has(id))),
    rootOrder: state.rootOrder, expanded: state.expanded, syncedBlocks: state.syncedBlocks, reminders: state.reminders,
    settings: state.settings, syncUserId: state.syncUserId, syncWorkspaceId: state.syncWorkspaceId };
}
function kvOf(state: LocalState): [string, unknown][] {
  return [...KV_KEYS.map((key): [string, unknown] => [key, state[key]]), ["sync", { syncUserId: state.syncUserId, syncWorkspaceId: state.syncWorkspaceId }]];
}
function readLegacy(): LocalState | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY); if (!raw) return null;
    const value = JSON.parse(raw)?.state as Partial<LocalState> | undefined;
    if (!value || !value.pages || Array.isArray(value.pages) || !Array.isArray(value.rootOrder)
      || !Object.entries(value.pages).every(([id, p]) => p && p.id === id && typeof p.title === "string" && Array.isArray(p.blocks))) return null;
    return { pages: value.pages, rootOrder: value.rootOrder, expanded: value.expanded ?? {}, syncedBlocks: value.syncedBlocks ?? {},
      reminders: value.reminders ?? [], settings: value.settings, syncUserId: value.syncUserId ?? null, syncWorkspaceId: value.syncWorkspaceId ?? null };
  } catch { return null; }
}
function openOrGiveUp(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = isSupabaseConfigured() ? setTimeout(() => finish(null), OPEN_TIMEOUT_MS) : null;
    const finish = (connection: IDBDatabase | null, error?: unknown) => {
      if (settled) { connection?.close(); return; }
      settled = true; if (timeout) clearTimeout(timeout); giveUp = null;
      if (error) reject(error); else resolve(connection);
    };
    giveUp = () => finish(null);
    void openLocalDb().then((connection) => finish(connection), (error) => finish(null, error));
  });
}
export function continueWithoutLocalCopy(): void { giveUp?.(); }
export function hydrateWorkspace(): Promise<void> { return hydration ??= hydrate(); }
export function stopLocalPersistence(): void { stopWriter(); }

async function stateFromDisk(connection: IDBDatabase, stored: StoredWorkspace): Promise<LocalState> {
  const bodies = await readBodies(connection, stored.metas.map((meta) => meta.id));
  if (stored.metas.some((meta) => !bodies.has(meta.id))) throw new Error("local_body_missing");
  const pages = Object.fromEntries(stored.metas.map((meta) => [meta.id, joinPage(meta, bodies.get(meta.id)!)]));
  const kv = stored.kv, sync = kv.sync as Pick<Store, "syncUserId" | "syncWorkspaceId"> | undefined;
  return { pages, rootOrder: (kv.rootOrder as string[] | undefined) ?? [], expanded: (kv.expanded as Record<string, boolean> | undefined) ?? {},
    syncedBlocks: kv.syncedBlocks as WorkspaceState["syncedBlocks"], reminders: (kv.reminders as WorkspaceState["reminders"]) ?? [],
    settings: kv.settings as WorkspaceState["settings"], syncUserId: sync?.syncUserId ?? null, syncWorkspaceId: sync?.syncWorkspaceId ?? null };
}
async function absorbLegacy(connection: IDBDatabase, legacy: LocalState): Promise<void> {
  const stored = await readWorkspace(connection), sync = stored.kv.sync as { syncUserId?: string } | undefined;
  if (!legacy.syncUserId || legacy.syncUserId === sync?.syncUserId) {
    const metas = new Map(stored.metas.map((meta) => [meta.id, meta])), added: string[] = [], pages: PageWrite[] = [];
    for (const page of Object.values(legacy.pages)) {
      const current = metas.get(page.id);
      if (current ? page.updatedAt > current.updatedAt : page.createdAt > Number(stored.kv.migratedAt ?? Infinity)) {
        pages.push(fullWrite(page)); if (!current && page.parentId === null && !page.isDeleted) added.push(page.id);
      }
    }
    const kv: [string, unknown][] = added.length ? [["rootOrder", [...new Set([...(stored.kv.rootOrder as string[] ?? []), ...added])]]] : [];
    if (pages.length) await writeBatch(connection, stored.epoch, { pages, kv });
  }
  localStorage.removeItem(LEGACY_KEY);
}
function startMemoryMode(): void {
  stopWriter();
}
function deleteLocalDb(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("local_db_blocked"));
  });
}
async function deleteFailedMigration(connection: IDBDatabase): Promise<void> {
  connection.close(); await deleteLocalDb();
}
function clearWasInterrupted(): boolean {
  try { return localStorage.getItem(CLEAR_PENDING_KEY) !== null; } catch { return false; }
}
function removeLegacy(): void {
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* Storage may be blocked. */ }
}
function unmarkClearPending(): void {
  try { localStorage.removeItem(CLEAR_PENDING_KEY); } catch { /* A retained marker safely retries next boot. */ }
}
async function writeCurrentState(connection: IDBDatabase, currentEpoch: string): Promise<void> {
  const state = currentState();
  await writeBatch(connection, currentEpoch, { pages: Object.values(state.pages).map((page) => fullWrite(page)), kv: kvOf(state) });
}

export async function clearLocalPages(): Promise<void> {
  try { localStorage.setItem(CLEAR_PENDING_KEY, "1"); } catch { /* Still clear IndexedDB if localStorage is blocked. */ }
  const connection = db;
  // Invalidates in-flight continuations as well as queued writes before any await.
  stopWriter(); removeLegacy();
  let cleared = false;
  if (connection) {
    const next = crypto.randomUUID();
    try {
      await wipeLocalDb(connection, next);
      await writeCurrentState(connection, next);
      startWriter(connection, next); cleared = true;
    } catch { connection.close(); }
  }
  if (!cleared) {
    cleared = await deleteLocalDb().then(() => true, () => false);
    startMemoryMode(); setHealth("unavailable");
  }
  if (cleared) unmarkClearPending();
}

async function hydrate(): Promise<void> {
  const interrupted = clearWasInterrupted(), legacy = interrupted ? null : readLegacy();
  if (interrupted) { removeLegacy(); applyingExternal(() => useStore.getState().clearLocalWorkspace()); }
  try {
    let opened = await openOrGiveUp(); if (!opened) throw new Error("local_db_timeout"); db = opened;
    if (interrupted) {
      const next = crypto.randomUUID();
      try { await wipeLocalDb(opened, next); await writeCurrentState(opened, next); }
      catch { opened.close(); await deleteLocalDb(); opened = await openLocalDb(); db = opened; }
    }
    const initial = legacy ?? currentState();
    const writes = Object.values(initial.pages).map((page) => ({ ...fullWrite(page), search: searchRecord(page, initial.syncedBlocks ?? {}) }));
    const claimed = await claimWorkspace(opened, writes, kvOf(initial), legacy ? Date.now() : null);
    if (claimed === "created" && legacy) {
      const counts = await countRecords(opened), expected = Object.keys(legacy.pages).length;
      if (counts.meta !== expected || counts.bodies !== expected) { await deleteFailedMigration(opened); throw new Error("local_copy_mismatch"); }
    }
    if (claimed === "existing" && legacy) await absorbLegacy(opened, legacy);
    const stored = await readWorkspace(opened);
    // Preserve the fresh seed's references; competing tabs instead read the winning claim.
    if (claimed !== "created" || legacy) {
      const state = await stateFromDisk(opened, stored);
      applyingExternal(() => useStore.setState(state));
    }
    startWriter(opened, stored.epoch); setHealth("ok");
    if (interrupted) unmarkClearPending();
  } catch {
    db?.close(); db = null;
    if (legacy) applyingExternal(() => useStore.setState(legacy));
    startMemoryMode(); setHealth("unavailable");
  }
  mark("colabora:hydrate:end");
  if (import.meta.env.DEV) recordHydration(pageDataSizes(useStore.getState().pages));
}
