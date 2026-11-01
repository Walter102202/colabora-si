import type { PageBody, PageMeta } from "@/lib/pageShell";

export const LOCAL_DB = "colabora-local", LOCAL_SCHEMA = 1;
export const STORES = ["meta", "bodies", "search", "kv"] as const;
export class StaleEpochError extends Error {
  constructor() { super("stale_local_epoch"); this.name = "StaleEpochError"; }
}
export interface SearchRecord { id: string; text: string; comments: string; cells?: Record<string, string> }
export type PageWrite =
  | { kind: "full"; id: string; meta: PageMeta; body: PageBody; search: SearchRecord; remote?: boolean }
  | { kind: "meta"; id: string; meta: Omit<PageMeta, "bodyRev" | "links"> }
  | { kind: "delete"; id: string };
export interface WriteBatch { pages: PageWrite[]; kv: [string, unknown][] }
export interface StoredWorkspace { metas: PageMeta[]; kv: Record<string, unknown>; epoch: string }
export type PageReconciler = (current: { meta: PageMeta; body?: PageBody } | undefined) => Extract<PageWrite, { kind: "full" }> | null;

export function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB, LOCAL_SCHEMA);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("meta", { keyPath: "id" }).createIndex("links", "links", { multiEntry: true });
      db.createObjectStore("bodies", { keyPath: "id" });
      db.createObjectStore("search", { keyPath: "id" });
      db.createObjectStore("kv");
    };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("local_db_blocked")); };
  });
}

function applyWrite(tx: IDBTransaction, write: PageWrite, reconcile?: PageReconciler): void {
  const meta = tx.objectStore("meta"), bodies = tx.objectStore("bodies"), search = tx.objectStore("search");
  if (write.kind === "delete") { meta.delete(write.id); bodies.delete(write.id); search.delete(write.id); return; }
  const request = meta.get(write.id);
  request.onsuccess = () => {
    const current = request.result as PageMeta | undefined;
    if (write.kind === "meta") {
      meta.put({ ...current, ...write.meta, bodyRev: current?.bodyRev ?? null, links: current?.links ?? [], rowOrigin: write.meta.rowOrigin });
      return;
    }
    if (write.remote && current?.bodyRev != null && current.bodyRev > (write.meta.bodyRev ?? 0)) return;
    const put = (value: Extract<PageWrite, { kind: "full" }> | null) => {
      if (value) { meta.put(value.meta); bodies.put(value.body); search.put(value.search); }
    };
    if (!reconcile) { put(write); return; }
    // Reconcile inside this transaction: a separate read would race another tab's save.
    const body = bodies.get(write.id);
    body.onsuccess = () => put(reconcile(current ? { meta: current, body: body.result as PageBody | undefined } : undefined));
  };
}

export function writeBatch(db: IDBDatabase, epoch: string, batch: WriteBatch, reconcilers?: ReadonlyMap<string, PageReconciler>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...STORES], "readwrite"), kv = tx.objectStore("kv");
    let stale = false;
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(stale ? new StaleEpochError() : tx.error);
    const request = kv.get("epoch");
    request.onsuccess = () => {
      // Read-write transactions serialize this check with wipes from every tab.
      if (request.result !== epoch) { stale = true; tx.abort(); return; }
      for (const write of batch.pages) applyWrite(tx, write, reconcilers?.get(write.id));
      for (const [key, value] of batch.kv) kv.put(value, key);
    };
  });
}

export function readPages(db: IDBDatabase, ids: string[], wanted: string[], keys: string[]): Promise<{ metas: Map<string, PageMeta>; bodies: Map<string, PageBody>; kv: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "bodies", "kv"], "readonly");
    const metas = new Map<string, PageMeta>(), bodies = new Map<string, PageBody>(), kv: Record<string, unknown> = {};
    for (const id of ids) { const request = tx.objectStore("meta").get(id); request.onsuccess = () => { if (request.result) metas.set(id, request.result as PageMeta); }; }
    for (const id of wanted) { const request = tx.objectStore("bodies").get(id); request.onsuccess = () => { if (request.result) bodies.set(id, request.result as PageBody); }; }
    for (const key of keys) if (["rootOrder", "syncedBlocks", "reminders", "settings"].includes(key)) {
      const request = tx.objectStore("kv").get(key); request.onsuccess = () => { if (request.result !== undefined) kv[key] = request.result; };
    }
    tx.oncomplete = () => resolve({ metas, bodies, kv }); tx.onabort = () => reject(tx.error);
  });
}

export function claimWorkspace(db: IDBDatabase, writes: PageWrite[], values: [string, unknown][], migratedAt: number | null): Promise<"created" | "existing"> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...STORES], "readwrite"), kv = tx.objectStore("kv");
    let result: "created" | "existing" = "existing";
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
    const schema = kv.get("schema");
    schema.onsuccess = () => {
      if (schema.result !== undefined) return;
      result = "created";
      for (const write of writes) applyWrite(tx, write);
      for (const [key, value] of values) kv.put(value, key);
      kv.put(crypto.randomUUID(), "epoch"); kv.put(LOCAL_SCHEMA, "schema"); kv.put(migratedAt, "migratedAt");
    };
  });
}

export function readWorkspace(db: IDBDatabase): Promise<StoredWorkspace> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "kv"], "readonly");
    const metas = tx.objectStore("meta").getAll(), keys = tx.objectStore("kv").getAllKeys(), values = tx.objectStore("kv").getAll();
    tx.oncomplete = () => {
      const kv = Object.fromEntries(keys.result.map((key, index) => [String(key), values.result[index]]));
      resolve({ metas: metas.result as PageMeta[], kv, epoch: typeof kv.epoch === "string" ? kv.epoch : "" });
    };
    tx.onabort = () => reject(tx.error);
  });
}

export function readBodies(db: IDBDatabase, ids: string[]): Promise<Map<string, PageBody>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("bodies", "readonly"), store = tx.objectStore("bodies"), bodies = new Map<string, PageBody>();
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => { if (request.result) bodies.set(id, request.result as PageBody); };
    }
    tx.oncomplete = () => resolve(bodies); tx.onabort = () => reject(tx.error);
  });
}

export function wipeLocalDb(db: IDBDatabase, epoch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...STORES], "readwrite");
    for (const name of STORES) tx.objectStore(name).clear();
    tx.objectStore("kv").put(LOCAL_SCHEMA, "schema"); tx.objectStore("kv").put(epoch, "epoch");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}

export function countRecords(db: IDBDatabase): Promise<{ meta: number; bodies: number }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "bodies"], "readonly");
    const meta = tx.objectStore("meta").count(), bodies = tx.objectStore("bodies").count();
    tx.oncomplete = () => resolve({ meta: meta.result, bodies: bodies.result }); tx.onabort = () => reject(tx.error);
  });
}

export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

export async function scanSearchRecords(db: IDBDatabase, batchSize: number, visit: (record: SearchRecord) => boolean): Promise<void> {
  let last: string | undefined;
  for (;;) {
    const records = await new Promise<SearchRecord[]>((resolve, reject) => {
      const tx = db.transaction("search", "readonly");
      const request = tx.objectStore("search").getAll(last === undefined ? undefined : IDBKeyRange.lowerBound(last, true), batchSize);
      tx.oncomplete = () => resolve(request.result as SearchRecord[]); tx.onabort = () => reject(tx.error);
    });
    for (const record of records) if (!visit(record)) return;
    if (records.length < batchSize) return;
    last = records[records.length - 1].id;
  }
}
