import type { PageOp, WorkspaceOp } from "@/lib/pageOps";

export interface OpsQueue {
  enqueue(pageId: string, ops: PageOp[]): void;
  peek(pageId: string): PageOp[];
  ack(pageId: string, count: number): void;
  setRevision(pageId: string, rev: number): void;
  getRevision(pageId: string): number;
  clearAll(): void;
}
type Entry = { id: string; op: PageOp };
type Pending = { entries: Entry[]; deleted?: boolean; workspace?: WorkspaceOp[] };
const WORKSPACE = "@workspace";
export class MemoryQueue implements OpsQueue {
  protected pending = new Map<string, Pending>();
  protected revisions = new Map<string, number>();
  protected changed(_pageId: string): void { void _pageId; }
  enqueue(pageId: string, ops: PageOp[]): void {
    const previous = this.pending.get(pageId);
    const entries = [...(previous?.entries ?? [])];
    for (let op of ops) {
      if ("rev" in op && op.rev !== undefined) {
        const id = "id" in op ? op.id : op.rowId;
        const prior = entries.map((e) => e.op).findLast((p) => "rev" in p && ("id" in p ? p.id : p.rowId) === id);
        if (prior && "rev" in prior && prior.rev !== undefined) op = { ...op, rev: Math.max(op.rev, prior.rev + 1) };
      }
      entries.push({ id: crypto.randomUUID(), op });
    }
    this.pending.set(pageId, { entries });
    this.changed(pageId);
  }
  peek(pageId: string): PageOp[] { return (this.pending.get(pageId)?.entries ?? []).map((entry) => entry.op); }
  ack(pageId: string, count: number): void {
    const current = this.pending.get(pageId);
    if (current) this.pending.set(pageId, { ...current, entries: current.entries.slice(count) });
    this.changed(pageId);
  }
  batchKey(pageId: string, count: number): string {
    const entries = this.pending.get(pageId)?.entries ?? [];
    return `${entries[0]?.id}:${entries[Math.min(count, entries.length) - 1]?.id}`;
  }
  rebaseRevisions(pageId: string, revisions: Map<string, number>): void {
    const pending = this.pending.get(pageId); if (!pending) return;
    const next = new Map(revisions);
    this.pending.set(pageId, { ...pending, entries: pending.entries.map((entry) => {
      const op = entry.op;
      if (!("rev" in op)) return entry;
      const id = "id" in op ? op.id : op.rowId, rev = next.get(id);
      if (rev === undefined) return entry;
      next.set(id, rev + 1); return { ...entry, op: { ...op, rev } };
    }) });
    this.changed(pageId);
  }
  setRevision(pageId: string, rev: number): void { this.revisions.set(pageId, Math.max(rev, this.getRevision(pageId))); this.changed(pageId); }
  getRevision(pageId: string): number { return this.revisions.get(pageId) ?? 0; }
  pageIds(): string[] { return [...this.pending.keys()].filter((id) => id !== WORKSPACE); }
  markDeleted(pageId: string): void { this.pending.set(pageId, { entries: [], deleted: true }); this.changed(pageId); }
  isDeleted(pageId: string): boolean { return !!this.pending.get(pageId)?.deleted; }
  clearPage(pageId: string): void { this.pending.delete(pageId); this.changed(pageId); }
  enqueueWorkspace(ops: WorkspaceOp[]): void {
    this.pending.set(WORKSPACE, { entries: [], workspace: [...this.peekWorkspace(), ...ops] }); this.changed(WORKSPACE);
  }
  peekWorkspace(): WorkspaceOp[] { return this.pending.get(WORKSPACE)?.workspace ?? []; }
  ackWorkspace(count: number): void { this.pending.set(WORKSPACE, { entries: [], workspace: this.peekWorkspace().slice(count) }); this.changed(WORKSPACE); }
  clearAll(): void {
    const ids = new Set([...this.pending.keys(), ...this.revisions.keys()]);
    this.pending.clear(); this.revisions.clear(); for (const id of ids) this.changed(id);
  }
  async settled(): Promise<void> {}
}

export class IndexedDbQueue extends MemoryQueue {
  readonly ready: Promise<void>;
  private db: IDBDatabase | null = null;
  private writes: Promise<void> = Promise.resolve();
  private release: (() => void) | null = null;
  private readonly prefix: string;
  private closed = false;
  constructor(private scope: string, private owner: string) {
    super(); this.prefix = `${scope}|${owner}|`;
    this.ready = this.open();
  }
  private async open(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("colabora-sync", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("ops"); request.result.createObjectStore("revisions"); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const load = async () => {
      const tx = this.db!.transaction(["ops", "revisions"], "readonly");
      const entries = await Promise.all(["ops", "revisions"].map((store) => new Promise<[IDBValidKey[], unknown[]]>((resolve, reject) => {
        const keys = tx.objectStore(store).getAllKeys(), values = tx.objectStore(store).getAll();
        values.onsuccess = () => resolve([keys.result, values.result]); values.onerror = () => reject(values.error);
      })));
      for (const [index, [keys, values]] of entries.entries()) keys.forEach((key, i) => {
        if (!String(key).startsWith(this.prefix)) return;
        const id = String(key).slice(this.prefix.length);
        if (index === 0) this.pending.set(id, values[i] as Pending); else this.revisions.set(id, values[i] as number);
      });
      const orphanOwners = new Set(entries[0][0].map(String).filter((key) => key.startsWith(`${this.scope}|`) && !key.startsWith(this.prefix)).map((key) => key.split("|")[1]));
      if (navigator.locks) for (const owner of orphanOwners) await navigator.locks.request(`colabora-queue:${this.scope}:${owner}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        const oldPrefix = `${this.scope}|${owner}|`, move = this.db!.transaction(["ops", "revisions"], "readwrite");
        entries[0][0].forEach((key, i) => {
          if (!String(key).startsWith(oldPrefix)) return;
          const id = String(key).slice(oldPrefix.length), value = entries[0][1][i] as Pending, current = this.pending.get(id);
          const combined = { ...value, entries: [...value.entries, ...(current?.entries ?? [])], workspace: [...(value.workspace ?? []), ...(current?.workspace ?? [])] };
          this.pending.set(id, combined); move.objectStore("ops").put(combined, this.prefix + id); move.objectStore("ops").delete(key);
          move.objectStore("revisions").delete(key);
        });
        await new Promise<void>((resolve, reject) => { move.oncomplete = () => resolve(); move.onerror = () => reject(move.error); });
      });
    };
    if (!navigator.locks) { await load(); return; }
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request(`colabora-queue:${this.scope}:${this.owner}`, async () => {
        try { await load(); resolve(); if (!this.closed) await new Promise<void>((done) => { this.release = done; }); }
        catch (error) { reject(error); }
      });
    });
  }
  protected changed(pageId: string): void {
    const pending = this.pending.get(pageId), revision = this.revisions.get(pageId);
    this.writes = this.writes.then(() => this.ready).then(() => new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(["ops", "revisions"], "readwrite"), key = this.prefix + pageId;
      if (pending) tx.objectStore("ops").put(pending, key); else tx.objectStore("ops").delete(key);
      if (revision !== undefined) tx.objectStore("revisions").put(revision, key); else tx.objectStore("revisions").delete(key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }));
    void this.writes.catch(() => {});
  }
  async settled(): Promise<void> { await this.ready; await this.writes; }
  async close(): Promise<void> { this.closed = true; try { await this.settled(); } finally { this.release?.(); this.db?.close(); } }
}
