import { useEffect, useState } from "react";
import { create } from "zustand";
import { getSupabase } from "@/lib/supabase";
import { useStore } from "@/lib/store";
import type { Block, Page } from "@/lib/types";
import { flushLocalWrites, hasMissingBodies, readLocalPageSnapshot, scanStoredPages } from "@/lib/localPersistence";
export interface FileBackend { registerRow(id: string, ws: string): Promise<boolean>; putObject(id: string, ws: string, blob: Blob): Promise<boolean> }
export async function uploadRowFirst(backend: FileBackend, id: string, ws: string, blob: Blob): Promise<"done" | "row_failed" | "object_failed"> {
  if (!await backend.registerRow(id, ws)) return "row_failed";
  if (!await backend.putObject(id, ws, blob)) return "object_failed";
  return "done";
}
export const useUploadState = create<{ uploading: Record<string, true>; start(id: string): void; finish(id: string): void; clear(): void }>((set) => ({
  uploading: {},
  start: (id) => set((s) => ({ uploading: { ...s.uploading, [id]: true } })),
  finish: (id) => set((s) => { const uploading = { ...s.uploading }; delete uploading[id]; return { uploading }; }),
  clear: () => set({ uploading: {} }),
}));
export function useUploading(fileId?: string): boolean { return useUploadState((s) => !!fileId && !!s.uploading[fileId]); }
export function hasPendingUploads(): boolean { return Object.keys(useUploadState.getState().uploading).length > 0; }
const DB_NAME = "colabora-files", BUCKET = "files", THROTTLE_MS = 400, MAX_BACKOFF_MS = 30000;
const CLEAR_FILES_KEY = "colabora-files-clear-pending";
let dbPromise: Promise<IDBDatabase> | null = null;
let clearPending = false, clearingFiles: Promise<void> | null = null;
function clearMarker(): string | null { try { return localStorage.getItem(CLEAR_FILES_KEY); } catch { return null; } }
function database(): Promise<IDBDatabase> {
  return dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => { for (const name of ["files", "uploaded"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => { dbPromise = null; reject(request.error); };
  });
}
async function ensureFileCache(): Promise<void> {
  while (clearPending || clearMarker()) {
    if (!clearingFiles) {
      const marker = clearMarker();
      clearingFiles = (async () => {
        const db = await database();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(["files", "uploaded"], "readwrite");
          tx.objectStore("files").clear(); tx.objectStore("uploaded").clear();
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
        if (clearMarker() === marker) {
          if (marker !== null) localStorage.removeItem(CLEAR_FILES_KEY);
          clearPending = false;
        }
      })().finally(() => { clearingFiles = null; });
    }
    await clearingFiles;
  }
}
async function local<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest, token = epoch): Promise<T> {
  if (token !== epoch) throw new Error("file_session_changed");
  await ensureFileCache();
  const db = await database();
  if (token !== epoch) throw new Error("file_session_changed");
  return new Promise((resolve, reject) => { const tx = db.transaction(store, mode), request = action(tx.objectStore(store)); tx.oncomplete = () => token === epoch ? resolve(request.result as T) : reject(new Error("file_session_changed")); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
const putLocal = (id: string, blob: Blob, token = epoch) => local("files", "readwrite", (s) => s.put(blob, id), token);
const getLocal = (id: string) => local<Blob | undefined>("files", "readonly", (s) => s.get(id));
const markUploaded = (id: string, ws: string, token = epoch) => local("uploaded", "readwrite", (s) => s.put(ws, id), token);
export async function clearLocalFiles(): Promise<void> {
  onFileSyncStop(); downloads.clear(); clearPending = true;
  try { localStorage.setItem(CLEAR_FILES_KEY, crypto.randomUUID()); } catch { /* Keep the in-memory barrier when storage is blocked. */ }
  await ensureFileCache();
}
let wsId: string | null = null, epoch = 0, running = false, attempts = 0, retryTimer: ReturnType<typeof setTimeout> | null = null;
const queue: string[] = [], queuedSet = new Set<string>(), downloads = new Map<string, Promise<Blob | undefined>>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function uploadOne(id: string, ws: string): Promise<boolean> {
  const token = epoch;
  const sb = getSupabase(); if (!sb) { useUploadState.getState().finish(id); return true; }
  const blob = await getLocal(id).catch(() => undefined); if (token !== epoch) return false;
  if (!blob) { useUploadState.getState().finish(id); return true; }
  const outcome = await uploadRowFirst({
    registerRow: async (id, ws) => !(await sb.from("files").upsert({ id, workspace_id: ws })).error,
    putObject: async (id, ws, blob) => !(await sb.storage.from(BUCKET).upload(ws + "/" + id, blob, { upsert: true, contentType: blob.type || "application/octet-stream" })).error,
  }, id, ws, blob);
  if (outcome !== "done" || token !== epoch) return false;
  await markUploaded(id, ws, token); useUploadState.getState().finish(id); return true;
}
async function pump(): Promise<void> {
  if (running || !wsId || retryTimer || !navigator.onLine) return;
  const token = epoch, ws = wsId; running = true;
  try {
    while (queue.length && token === epoch && navigator.onLine) {
      const id = queue[0], ok = await uploadOne(id, ws).catch(() => false); if (token !== epoch) return;
      if (!ok) { retryTimer = setTimeout(() => { retryTimer = null; void pump(); }, Math.min(1000 * 2 ** ++attempts, MAX_BACKOFF_MS)); return; }
      queue.shift(); queuedSet.delete(id); attempts = 0; if (queue.length) await delay(THROTTLE_MS);
    }
  } finally { if (token === epoch) running = false; }
}
// Exported for tests. Without a backend or before the workspace is known (signed out, bootstrap pending) nothing can be sent:
// onFileSyncStart re-enqueues every file not yet uploaded for the workspace, so returning here leaves no state behind.
export function enqueueUpload(id: string): void { if (!getSupabase() || !wsId) return; if (!queuedSet.has(id)) { useUploadState.getState().start(id); queuedSet.add(id); queue.push(id); } void pump(); }
export async function putFile(id: string, blob: Blob): Promise<void> { const token = epoch; await putLocal(id, blob, token); if (token === epoch) enqueueUpload(id); }
async function downloadRemote(id: string): Promise<Blob | undefined> {
  const token = epoch;
  const sb = getSupabase(); if (!sb) return;
  const download = async (owner: string) => { const { data, error } = await sb.storage.from(BUCKET).download(owner + "/" + id); if (token !== epoch || error || !data) return; await putLocal(id, data, token); await markUploaded(id, owner, token); return token === epoch ? data : undefined; };
  if (wsId) { const data = await download(wsId); if (token !== epoch || data) return data; }
  const { data } = await sb.from("files").select("workspace_id").eq("id", id).maybeSingle();
  if (token !== epoch) return;
  if (data?.workspace_id && data.workspace_id !== wsId) return download(data.workspace_id);
}
export async function getFile(id: string): Promise<Blob | undefined> {
  const token = epoch, blob = await getLocal(id); if (token !== epoch) return; if (blob) return blob;
  if (!downloads.has(id)) downloads.set(id, downloadRemote(id).finally(() => { if (token === epoch) downloads.delete(id); }));
  return downloads.get(id);
}
export async function deleteFile(id: string): Promise<void> {
  const token = epoch, workspace = wsId, sb = getSupabase();
  await local("files", "readwrite", (s) => s.delete(id), token);
  if (workspace && sb && token === epoch) { await sb.storage.from(BUCKET).remove([workspace + "/" + id]); if (token === epoch) await sb.from("files").delete().eq("id", id).eq("workspace_id", workspace); }
  await local("uploaded", "readwrite", (s) => s.delete(id), token);
}
export function useFileUrl(fileId?: string): string | null {
  const [result, setResult] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => { let alive = true, url: string | null = null; if (fileId) void getFile(fileId).then((blob) => { if (alive && blob) { url = URL.createObjectURL(blob); setResult({ id: fileId, url }); } }).catch(() => {}); return () => { alive = false; if (url) URL.revokeObjectURL(url); }; }, [fileId]);
  return result && result.id === fileId ? result.url : null;
}
export function collectBlockFileIds(blocks: Block[], ids = new Set<string>()): Set<string> {
  for (const block of blocks) { if (block.fileId) ids.add(block.fileId); for (const column of block.columns ?? []) collectBlockFileIds(column.blocks, ids); for (const action of block.buttonActions ?? []) if (action.kind === "insertBlocks") collectBlockFileIds(action.blocks, ids); }
  return ids;
}
function collectPageFileIds(page: Page, ids: Set<string>): void {
  for (const value of Object.values(page.rowOrigin?.row.cells ?? {})) if (Array.isArray(value)) for (const file of value) if (file && typeof file === "object" && typeof file.fileId === "string") ids.add(file.fileId);
  collectBlockFileIds(page.blocks, ids); for (const version of page.versions ?? []) collectBlockFileIds(version.blocks, ids); for (const template of page.database?.rowTemplates ?? []) collectBlockFileIds(template.blocks, ids);
  for (const row of page.database?.rows ?? []) for (const prop of page.database?.properties ?? []) if (prop.type === "files" && Array.isArray(row.cells[prop.id])) for (const file of row.cells[prop.id] as { fileId?: string }[]) if (file.fileId) ids.add(file.fileId);
}
export function referencedFileIds(pages: Record<string, Page>, synced: Record<string, Block[]> = {}): string[] {
  const ids = new Set<string>();
  for (const page of Object.values(pages)) collectPageFileIds(page, ids);
  for (const blocks of Object.values(synced)) collectBlockFileIds(blocks, ids);
  return [...ids];
}
export async function listReferencedFileIds(): Promise<string[] | null> {
  await flushLocalWrites();
  if (await hasMissingBodies()) return null;
  const state = useStore.getState(), ids = new Set(referencedFileIds(state.pages, state.syncedBlocks));
  await scanStoredPages((page) => collectPageFileIds(page, ids));
  return [...ids];
}
function collectSnapshotFileIds(ids: string[], pages: Record<string, Page>): Promise<string[]> {
  const files = new Set<string>();
  // Metadata includes archived row cells even when a body is not available.
  for (const id of ids) if (pages[id]) collectPageFileIds(pages[id], files);
  return readLocalPageSnapshot(ids).then((snapshot) => {
    for (const page of snapshot) collectPageFileIds(page, files);
    return [...files];
  });
}
export function collectSubtreeFileIds(rootId: string): Promise<string[]> {
  const { pages } = useStore.getState(), seen = new Set<string>();
  const walk = (id: string) => { if (seen.has(id) || !pages[id]) return; seen.add(id); for (const page of Object.values(pages)) if (page.parentId === id) walk(page.id); };
  walk(rootId); return collectSnapshotFileIds([...seen], pages);
}
export function collectTrashFileIds(): Promise<string[]> {
  const { pages } = useStore.getState();
  return collectSnapshotFileIds(Object.values(pages).filter((page) => page.isDeleted).map((page) => page.id), pages);
}
export function scheduleBlobGc(ids: string[], delayMs = 30000): void {
  const token = epoch;
  setTimeout(() => { void (async () => {
    if (token !== epoch) return;
    const references = await listReferencedFileIds(); if (!references || token !== epoch) return;
    const keep = new Set(references);
    for (const id of ids) { if (token !== epoch) return; if (!keep.has(id)) await deleteFile(id).catch(() => {}); }
  })().catch(() => {}); }, delayMs);
}
export async function cleanupUnusedFiles(): Promise<{ deleted: number; bytes: number }> {
  const token = epoch, references = await listReferencedFileIds(); if (!references) throw new Error("pages_not_on_device");
  if (token !== epoch) throw new Error("file_session_changed");
  const referenced = new Set(references), keys = await local<string[]>("files", "readonly", (s) => s.getAllKeys()), removed = new Set<string>(); let bytes = 0;
  for (const id of keys) if (!referenced.has(id)) { bytes += (await getLocal(id))?.size ?? 0; if (token !== epoch) throw new Error("file_session_changed"); await deleteFile(id); removed.add(id); }
  if (token !== epoch) throw new Error("file_session_changed");
  const sb = getSupabase(); if (sb && wsId) { const { data } = await sb.from("files").select("id").eq("workspace_id", wsId); for (const row of data ?? []) if (!referenced.has(row.id) && !removed.has(row.id)) { if (token !== epoch) throw new Error("file_session_changed"); await deleteFile(row.id); removed.add(row.id); } }
  return { deleted: removed.size, bytes };
}
const online = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; attempts = 0; void pump(); };
async function pendingUploadIds(): Promise<string[]> {
  const token = epoch; await ensureFileCache();
  const db = await database();
  if (token !== epoch) return [];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["files", "uploaded"], "readonly"), keys = tx.objectStore("files").getAllKeys();
    const uploadedKeys = tx.objectStore("uploaded").getAllKeys(), uploadedValues = tx.objectStore("uploaded").getAll();
    tx.oncomplete = () => {
      const uploaded = new Map(uploadedKeys.result.map((id, index) => [String(id), uploadedValues.result[index]]));
      resolve(token === epoch ? keys.result.map(String).filter((id) => !uploaded.has(id)) : []);
    };
    tx.onabort = () => reject(tx.error);
  });
}
export function onFileSyncStart(id: string): void {
  if (wsId === id) return; onFileSyncStop(); wsId = id; window.addEventListener("online", online); const token = epoch;
  void (async () => { for (const fileId of await pendingUploadIds()) { if (token !== epoch) return; enqueueUpload(fileId); await delay(THROTTLE_MS); } })().catch(() => {}); void pump();
}
export function onFileSyncStop(): void { window.removeEventListener("online", online); epoch++; if (retryTimer) clearTimeout(retryTimer); retryTimer = null; queue.length = 0; queuedSet.clear(); downloads.clear(); wsId = null; running = false; attempts = 0; useUploadState.getState().clear(); }
