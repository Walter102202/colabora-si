import { useStore, type Store, type RemotePatch } from "@/lib/store";
import type { Page, WorkspaceState } from "@/lib/types";
import { create } from "zustand";
import { foreignPageIds } from "@/lib/foreignPages";
import { applyingExternal, isApplyingExternal } from "@/lib/externalApply";
import { isShell, joinPage, overlayMeta, shellFromMeta, splitPage } from "@/lib/pageShell";
import { claimWorkspace, countRecords, isQuotaError, LOCAL_DB, openLocalDb, readBodies, readPages, readWorkspace, StaleEpochError, writeBatch, wipeLocalDb, type PageReconciler, type PageWrite, type StoredWorkspace } from "@/lib/localDb";
import { searchRecord } from "@/lib/search";
import { isSupabaseConfigured } from "@/lib/supabase";
import { mark, pageDataSizes, recordHydration } from "@/lib/metrics";
import { applyOps, diffPageToOps } from "@/lib/pageOps";
import { referrers, scanSearchRecords, type SearchRecord } from "@/lib/localDb";

const WRITE_DELAY_MS = 300, WRITE_CHUNK = 200, MAX_RETRY_MS = 30_000;
const KV_KEYS = ["rootOrder", "expanded", "syncedBlocks", "reminders", "settings"] as const;
let db: IDBDatabase | null = null, epoch = "", generation = 0;
let unsubscribe: (() => void) | null = null, removeListeners: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null, flushing: Promise<void> | null = null, retryMs = 1000;
const dirtyPages = new Map<string, Page | null>(), remotePages = new Set<string>(), dirtyKv = new Map<string, unknown>();
const TAB = crypto.randomUUID(), ACTIVE_EDIT_MS = 2000;
const writtenBase = new Map<string, Page>(), lastEdit = new Map<string, number>(), peerTimers = new Map<string, ReturnType<typeof setTimeout>>();
let channel: BroadcastChannel | null = null, applyingPeer = false;
let editedSinceStart = false, persistRequested = false, reopenedAfterFailure = false;
let cloudHasEverything = () => false;

export function setCloudCheck(check: () => boolean): void { cloudHasEverything = check; }
export function hasUnsavedLocalChanges(): boolean {
  if (useLocalHealth.getState().health === "unavailable") return editedSinceStart && !cloudHasEverything();
  return hasPendingLocalWrites() && useLocalHealth.getState().health !== "ok";
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (hasUnsavedLocalChanges()) { event.preventDefault(); event.returnValue = ""; }
}
function noteLocalEdit(state: Store, prev: Store): void {
  if (isApplyingExternal() || applyingPeer) return;
  if (state.pages !== prev.pages || KV_KEYS.some((key) => state[key] !== prev[key])) editedSinceStart = true;
}
function requestPersistence(): void {
  if (persistRequested || !navigator.storage?.persist || isSupabaseConfigured()) return;
  persistRequested = true;
  try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* This is an optional browser permission. */ }
}

export function diskAvailable(): boolean { return db !== null; }
export async function storedReferrers(id: string): Promise<string[]> {
  if (!db) return [];
  const token = generation, ids = await referrers(db, id);
  return token === generation ? ids : [];
}
export async function scanStoredSearchRecords(batchSize: number, visit: (record: SearchRecord) => boolean): Promise<boolean> {
  if (!db) return false;
  const token = generation;
  await scanSearchRecords(db, batchSize, (record) => token === generation && visit(record));
  return token === generation;
}
export async function readStoredPage(id: string): Promise<{ page: Page; stale: boolean } | null> {
  const pending = dirtyPages.get(id), memory = useStore.getState().pages[id];
  if (pending && !isShell(pending)) return { page: pending, stale: (pending.revision ?? 0) < (memory?.revision ?? 0) };
  if (!db || pending === null) return null;
  const token = generation;
  const stored = await readPages(db, [id], [id], []);
  if (token !== generation) return null;
  const meta = stored.metas.get(id), body = stored.bodies.get(id);
  if (!meta || meta.bodyRev === null || !body) return null;
  // A newer edit may have arrived while IndexedDB was reading.
  const latest = dirtyPages.get(id);
  if (latest === null) return null;
  const page = latest && !isShell(latest) ? latest : joinPage(meta, body);
  return { page, stale: (page.revision ?? 0) < (useStore.getState().pages[id]?.revision ?? meta.revision ?? 0) };
}
export async function hasMissingBodies(): Promise<boolean> {
  if (!db) return Object.values(useStore.getState().pages).some(isShell);
  const token = generation, connection = db;
  const metas = await new Promise<import("@/lib/pageShell").PageMeta[]>((resolve, reject) => {
    const tx = connection.transaction("meta", "readonly"), request = tx.objectStore("meta").getAll();
    tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
  });
  return token !== generation || metas.some((meta) => meta.bodyRev === null || meta.bodyRev < (meta.revision ?? 0));
}
export async function scanStoredPages(visit: (page: Page) => void): Promise<void> {
  if (!db) return;
  const token = generation, connection = db;
  const ids = await new Promise<string[]>((resolve, reject) => {
    const tx = connection.transaction("meta", "readonly"), request = tx.objectStore("meta").getAllKeys();
    tx.oncomplete = () => resolve(request.result.map(String)); tx.onabort = () => reject(tx.error);
  });
  for (let offset = 0; offset < ids.length; offset += WRITE_CHUNK) {
    if (token !== generation) throw new StaleEpochError();
    const batch = ids.slice(offset, offset + WRITE_CHUNK), stored = await readPages(connection, batch, batch, []);
    if (token !== generation) throw new StaleEpochError();
    for (const meta of stored.metas.values()) {
      const body = stored.bodies.get(meta.id);
      if (body && meta.bodyRev !== null) visit(joinPage(meta, body));
    }
  }
}
// Capture deletion candidates before the synchronous store mutation removes them.
export async function readLocalPageSnapshot(ids: string[]): Promise<Page[]> {
  const memory = useStore.getState().pages, pages = new Map<string, Page>();
  for (const id of ids) {
    const pending = dirtyPages.get(id), current = memory[id];
    if (current && !isShell(current)) pages.set(id, current);
    else if (pending && !isShell(pending)) pages.set(id, current ? overlayMeta(pending, current) : pending);
  }
  if (!db) return [...pages.values()];
  const token = generation, wanted = ids.filter((id) => !pages.has(id));
  // readPages queues its transaction synchronously, before the caller purges pages.
  const stored = await readPages(db, wanted, wanted, []);
  if (token !== generation) return [];
  for (const meta of stored.metas.values()) {
    const body = stored.bodies.get(meta.id); if (!body || meta.bodyRev === null) continue;
    const full = joinPage(meta, body), current = memory[meta.id];
    pages.set(meta.id, current ? overlayMeta(full, current) : full);
  }
  return [...pages.values()];
}
export function hasPendingLocalWrites(): boolean { return dirtyPages.size > 0 || dirtyKv.size > 0 || flushing !== null; }
export function fullWrite(page: Page, remote = false): Extract<PageWrite, { kind: "full" }> {
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
  if (applyingPeer) return;
  noteLocalEdit(state, prev);
  if (state.pages !== prev.pages) {
    for (const id in state.pages) {
      const before = prev.pages[id], after = state.pages[id];
      if (before === after) continue;
      if (before && isShell(before) !== isShell(after) && isApplyingExternal()) continue;
      if (!isApplyingExternal()) {
        lastEdit.set(id, Date.now());
        if (before && !isShell(before) && !isShell(after) && !writtenBase.has(id)) writtenBase.set(id, before);
      }
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

function reapply(theirs: Page, base: Page, local: Page): Page {
  if (JSON.stringify(theirs) === JSON.stringify(base)) return local;
  const ops = diffPageToOps(base, local);
  if (!ops.length) return theirs;
  return { ...applyOps(theirs, ops, { by: "human", id: useStore.getState().syncUserId ?? "local", at: local.updatedAt }).page, updatedAt: Math.max(theirs.updatedAt, local.updatedAt) };
}
function applyPeer(patch: RemotePatch): void {
  applyingPeer = true;
  try { applyingExternal(() => useStore.getState().applyLocalPages(patch)); }
  finally { applyingPeer = false; }
}
function reloadLocalCopy(): void { stopWriter(); if (typeof location !== "undefined") location.reload(); }
function announce(message: { type: "changed"; pages: string[]; kv: string[] } | { type: "cleared" }): void {
  try { channel?.postMessage({ ...message, tab: TAB }); } catch { /* A disabled channel does not prevent local saving. */ }
}
function deferPeer(id: string, delay: number): void {
  if (peerTimers.has(id)) return;
  peerTimers.set(id, setTimeout(() => {
    peerTimers.delete(id); void applyPeerChange([id], []).catch(() => {});
  }, delay));
}
async function applyPeerChange(ids: string[], keys: string[]): Promise<void> {
  if (!db) return;
  const token = generation, wanted = ids.filter((id) => !isShell(useStore.getState().pages[id]));
  const stored = await readPages(db, ids, wanted, keys);
  if (token !== generation) return;
  const state = useStore.getState(), pages: Record<string, Page | null> = {};
  for (const id of ids) {
    if (foreignPageIds.has(id)) continue;
    const remaining = ACTIVE_EDIT_MS - (Date.now() - (lastEdit.get(id) ?? -Infinity));
    if (remaining > 0 || flushing) { deferPeer(id, Math.max(50, remaining)); continue; }
    const meta = stored.metas.get(id), current = state.pages[id], body = stored.bodies.get(id);
    if (!meta) { pages[id] = null; dirtyPages.delete(id); writtenBase.delete(id); continue; }
    if (!body) { pages[id] = shellFromMeta(meta); continue; }
    const theirs = joinPage(meta, body), base = writtenBase.get(id);
    pages[id] = base && current && !isShell(current) ? reapply(theirs, base, current) : theirs;
    if (base) { writtenBase.set(id, theirs); markPage(id, pages[id]); }
  }
  applyPeer({ pages, ...stored.kv } as RemotePatch);
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
    const bases = new Map(pages.flatMap(([id]) => writtenBase.has(id) ? [[id, writtenBase.get(id)!] as const] : []));
    const reconciled = new Map<string, Page | null>(), reconcilers = new Map<string, PageReconciler>();
    for (const [id, page] of pages) {
      const base = bases.get(id);
      if (base && page && !isShell(page) && !remote.has(id)) reconcilers.set(id, (stored) => {
        // A page can be edited again before its first save; absence is not a tombstone.
        const merged = stored?.body ? reapply(joinPage(stored.meta, stored.body), base, page) : page;
        reconciled.set(id, merged); return fullWrite(merged);
      });
      dirtyPages.delete(id); remotePages.delete(id); writtenBase.delete(id);
    }
    dirtyKv.clear();
    try {
      await writeBatch(connection, currentEpoch, { pages: pages.filter(([id]) => !foreignPageIds.has(id)).map(([id, page]) => pageWrite(id, page, remote.has(id))), kv }, reconcilers);
      if (token === generation) {
        retryMs = 1000; reopenedAfterFailure = false; setHealth("ok"); requestPersistence();
        const patch: Record<string, Page | null> = {}, snapshots = new Map(pages), current = useStore.getState().pages;
        for (const [id, committed] of reconciled) {
          const snapshot = snapshots.get(id), now = current[id];
          if (!committed) { patch[id] = null; dirtyPages.delete(id); writtenBase.delete(id); continue; }
          if (!now || !snapshot || isShell(now) || remotePages.has(id)) continue;
          const next = now === snapshot ? committed : reapply(committed, snapshot, now);
          if (next !== now) patch[id] = next;
          if (dirtyPages.has(id)) { dirtyPages.set(id, next); writtenBase.set(id, committed); }
        }
        if (Object.keys(patch).length) applyPeer({ pages: patch });
        announce({ type: "changed", pages: pages.map(([id]) => id), kv: kv.map(([key]) => key) });
      }
    } catch (error) {
      if (token === generation) {
        if (error instanceof StaleEpochError) { reloadLocalCopy(); throw error; }
        setHealth(isQuotaError(error) ? "full" : "failing");
        for (const [id, page] of pages) if (!foreignPageIds.has(id)) {
          const newer = dirtyPages.get(id);
          if (!dirtyPages.has(id)) { dirtyPages.set(id, page); if (remote.has(id)) remotePages.add(id); }
          else if (page && !isShell(page) && newer && isShell(newer)) dirtyPages.set(id, overlayMeta(page, newer));
          const base = bases.get(id); if (base) writtenBase.set(id, base);
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
  const task = (async () => {
    if (useLocalHealth.getState().health === "failing" && !reopenedAfterFailure) {
      reopenedAfterFailure = true;
      try {
        const connection = await openLocalDb();
        if (token !== generation) { connection.close(); return; }
        db?.close(); db = connection;
      } catch { /* Retry the existing connection without discarding the pending batch. */ }
    }
    if (token === generation && db) await writeNow(token, db, epoch);
  })().finally(() => {
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
  editedSinceStart = false; reopenedAfterFailure = false;
  dirtyPages.clear(); remotePages.clear(); dirtyKv.clear();
  writtenBase.clear(); lastEdit.clear();
  for (const timer of peerTimers.values()) clearTimeout(timer);
  peerTimers.clear(); channel?.close(); channel = null;
}

export function startWriter(connection: IDBDatabase, currentEpoch: string): () => void {
  stopWriter(); db = connection; epoch = currentEpoch;
  const token = generation;
  unsubscribe = useStore.subscribe(onStoreChange);
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("colabora-local");
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; tab?: string; pages?: unknown; kv?: unknown } | null;
        if (!message || message.tab === TAB) return;
        if (message.type === "cleared") { reloadLocalCopy(); return; }
        if (message.type === "changed" && Array.isArray(message.pages) && Array.isArray(message.kv)) {
          void applyPeerChange(message.pages.filter((id): id is string => typeof id === "string"), message.kv.filter((key): key is string => typeof key === "string")).catch(() => {});
        }
      };
    }
  } catch { channel = null; }
  if (typeof window !== "undefined") {
    const flush = () => { void flushLocalWrites().catch(() => {}); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden); window.addEventListener("beforeunload", beforeUnload);
    removeListeners = () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("beforeunload", beforeUnload); };
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
  unsubscribe = useStore.subscribe(noteLocalEdit);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", beforeUnload);
    removeListeners = () => window.removeEventListener("beforeunload", beforeUnload);
  }
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
  const connection = db, previousChannel = channel; channel = null;
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
  try { previousChannel?.postMessage({ type: "cleared", tab: TAB }); } catch { /* Epoch checks still reject old writers. */ }
  finally { previousChannel?.close(); }
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
    if (claimed === "created") requestPersistence();
    if (interrupted) unmarkClearPending();
  } catch {
    db?.close(); db = null;
    if (legacy) applyingExternal(() => useStore.setState(legacy));
    startMemoryMode(); setHealth("unavailable");
  }
  mark("colabora:hydrate:end");
  if (import.meta.env.DEV) recordHydration(pageDataSizes(useStore.getState().pages));
}
