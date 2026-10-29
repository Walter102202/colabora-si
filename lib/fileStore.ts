import { useEffect, useState } from "react";
import { create } from "zustand";
import { getSupabase } from "@/lib/supabase";
import { useStore } from "@/lib/store";
import type { Block, Page } from "@/lib/types";
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
const DB_NAME = "colabora-files", BUCKET = "files", THROTTLE_MS = 400, MAX_BACKOFF_MS = 30000;
let dbPromise: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  return dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => { for (const name of ["files", "uploaded"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => { dbPromise = null; reject(request.error); };
  });
}
async function local<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction(store, mode), request = action(tx.objectStore(store)); tx.oncomplete = () => resolve(request.result as T); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
const putLocal = (id: string, blob: Blob) => local("files", "readwrite", (s) => s.put(blob, id));
const getLocal = (id: string) => local<Blob | undefined>("files", "readonly", (s) => s.get(id));
const markUploaded = (id: string, ws: string) => local("uploaded", "readwrite", (s) => s.put(ws, id));
let wsId: string | null = null, epoch = 0, running = false, attempts = 0, retryTimer: ReturnType<typeof setTimeout> | null = null;
const queue: string[] = [], queuedSet = new Set<string>(), downloads = new Map<string, Promise<Blob | undefined>>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function uploadOne(id: string, ws: string): Promise<boolean> {
  const sb = getSupabase(); if (!sb) { useUploadState.getState().finish(id); return true; }
  const blob = await getLocal(id).catch(() => undefined); if (!blob) { useUploadState.getState().finish(id); return true; }
  const outcome = await uploadRowFirst({
    registerRow: async (id, ws) => !(await sb.from("files").upsert({ id, workspace_id: ws })).error,
    putObject: async (id, ws, blob) => !(await sb.storage.from(BUCKET).upload(ws + "/" + id, blob, { upsert: true, contentType: blob.type || "application/octet-stream" })).error,
  }, id, ws, blob);
  if (outcome !== "done") return false;
  await markUploaded(id, ws); useUploadState.getState().finish(id); return true;
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
export async function putFile(id: string, blob: Blob): Promise<void> { await putLocal(id, blob); enqueueUpload(id); }
async function downloadRemote(id: string): Promise<Blob | undefined> {
  const sb = getSupabase(); if (!sb) return;
  const download = async (owner: string) => { const { data, error } = await sb.storage.from(BUCKET).download(owner + "/" + id); if (error || !data) return; await putLocal(id, data); await markUploaded(id, owner); return data; };
  if (wsId) { const data = await download(wsId); if (data) return data; }
  const { data } = await sb.from("files").select("workspace_id").eq("id", id).maybeSingle();
  if (data?.workspace_id && data.workspace_id !== wsId) return download(data.workspace_id);
}
export async function getFile(id: string): Promise<Blob | undefined> {
  const blob = await getLocal(id); if (blob) return blob;
  if (!downloads.has(id)) downloads.set(id, downloadRemote(id).finally(() => downloads.delete(id)));
  return downloads.get(id);
}
export async function deleteFile(id: string): Promise<void> {
  await local("files", "readwrite", (s) => s.delete(id)); const sb = getSupabase();
  if (wsId && sb) { await sb.storage.from(BUCKET).remove([wsId + "/" + id]); await sb.from("files").delete().eq("id", id).eq("workspace_id", wsId); }
  await local("uploaded", "readwrite", (s) => s.delete(id));
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
  collectBlockFileIds(page.blocks, ids); for (const version of page.versions ?? []) collectBlockFileIds(version.blocks, ids); for (const template of page.database?.rowTemplates ?? []) collectBlockFileIds(template.blocks, ids);
  for (const row of page.database?.rows ?? []) for (const prop of page.database?.properties ?? []) if (prop.type === "files" && Array.isArray(row.cells[prop.id])) for (const file of row.cells[prop.id] as { fileId?: string }[]) if (file.fileId) ids.add(file.fileId);
}
export function listReferencedFileIds(): string[] { const s = useStore.getState(), ids = new Set<string>(); for (const page of Object.values(s.pages)) collectPageFileIds(page, ids); for (const blocks of Object.values(s.syncedBlocks ?? {})) collectBlockFileIds(blocks, ids); return [...ids]; }
export function collectSubtreeFileIds(rootId: string): string[] { const { pages } = useStore.getState(), ids = new Set<string>(), seen = new Set<string>(); const walk = (id: string) => { if (seen.has(id) || !pages[id]) return; seen.add(id); collectPageFileIds(pages[id], ids); for (const p of Object.values(pages)) if (p.parentId === id) walk(p.id); }; walk(rootId); return [...ids]; }
export function collectTrashFileIds(): string[] { const ids = new Set<string>(); for (const page of Object.values(useStore.getState().pages)) if (page.isDeleted) collectPageFileIds(page, ids); return [...ids]; }
export function scheduleBlobGc(ids: string[], delayMs = 30000): void { setTimeout(() => { const referenced = new Set(listReferencedFileIds()); for (const id of ids) if (!referenced.has(id)) void deleteFile(id).catch(() => {}); }, delayMs); }
export async function cleanupUnusedFiles(): Promise<{ deleted: number; bytes: number }> {
  const referenced = new Set(listReferencedFileIds()), keys = await local<string[]>("files", "readonly", (s) => s.getAllKeys()), removed = new Set<string>(); let bytes = 0;
  for (const id of keys) if (!referenced.has(id)) { bytes += (await getLocal(id))?.size ?? 0; await deleteFile(id); removed.add(id); }
  const sb = getSupabase(); if (sb && wsId) { const { data } = await sb.from("files").select("id").eq("workspace_id", wsId); for (const row of data ?? []) if (!referenced.has(row.id) && !removed.has(row.id)) { await deleteFile(row.id); removed.add(row.id); } }
  return { deleted: removed.size, bytes };
}
const online = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; attempts = 0; void pump(); };
export function onFileSyncStart(id: string): void {
  if (wsId === id) return; onFileSyncStop(); wsId = id; window.addEventListener("online", online); const token = epoch;
  void (async () => { for (const fileId of listReferencedFileIds()) { if (token !== epoch) return; if (await local<string>("uploaded", "readonly", (s) => s.get(fileId)) === id || !(await getLocal(fileId))) continue; if (token !== epoch) return; enqueueUpload(fileId); await delay(THROTTLE_MS); } })().catch(() => {}); void pump();
}
export function onFileSyncStop(): void { window.removeEventListener("online", online); epoch++; if (retryTimer) clearTimeout(retryTimer); retryTimer = null; queue.length = 0; queuedSet.clear(); wsId = null; running = false; attempts = 0; useUploadState.getState().clear(); }
