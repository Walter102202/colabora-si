export interface FakeIdbStats {
  puts: Record<string, number>;
  bytes: Record<string, number>;
  reads: Record<string, number>;
}

type Key = IDBValidKey;
type Index = { keyPath: string; multiEntry: boolean };
type Store = { keyPath?: string; values: Map<Key, unknown>; indexes: Map<string, Index> };
type Database = { version: number; stores: Map<string, Store>; connections: Set<Connection>; pending: Transaction[]; active?: Transaction };
const clone = <T>(value: T): T => structuredClone(value);
const compare = (a: Key, b: Key): number => a === b ? 0 : a < b ? -1 : 1;
const names = (values: string[]) => Object.assign(values, { contains: (name: string) => values.includes(name), item: (index: number) => values[index] ?? null });

class Range {
  constructor(readonly lower?: Key, readonly upper?: Key, readonly lowerOpen = false, readonly upperOpen = false) {}
  includes(key: Key): boolean {
    return (this.lower === undefined || compare(key, this.lower) > (this.lowerOpen ? 0 : -1))
      && (this.upper === undefined || compare(key, this.upper) < (this.upperOpen ? 0 : 1));
  }
  static lowerBound(key: Key, open = false) { return new Range(key, undefined, open); }
  static upperBound(key: Key, open = false) { return new Range(undefined, key, false, open); }
  static bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false) { return new Range(lower, upper, lowerOpen, upperOpen); }
  static only(key: Key) { return new Range(key, key); }
}
const matches = (key: Key, query?: Key | Range | null) => query == null || (query instanceof Range ? query.includes(key) : compare(key, query) === 0);

class Events extends EventTarget {
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  oncomplete: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
  onversionchange: ((event: Event) => void) | null = null;
  emit(type: string, extra = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), extra);
    this.dispatchEvent(event);
    const handler = this[`on${type}` as keyof Events];
    if (typeof handler === "function") (handler as (event: Event) => void).call(this, event);
    return event;
  }
}
class Request extends Events {
  result: unknown;
  error: DOMException | null = null;
  readyState = "pending";
  transaction: Transaction | null = null;
  source: unknown = null;
  success(value: unknown) { this.result = value; this.readyState = "done"; this.emit("success"); }
}

class Transaction extends Events {
  error: DOMException | null = null;
  readonly objectStoreNames: ReturnType<typeof names>;
  private stores = new Map<string, Store>();
  private requests: { request: Request; run: () => unknown }[] = [];
  private running = false;
  private finished = false;
  constructor(readonly db: Connection, readonly mode: IDBTransactionMode, storeNames: string[]) {
    super(); this.objectStoreNames = names(storeNames);
  }
  start() {
    if (this.finished) { this.release(); return; }
    for (const name of this.objectStoreNames) {
      const store = this.db.data.stores.get(name)!;
      this.stores.set(name, { ...store, values: clone(store.values), indexes: new Map(store.indexes) });
    }
    this.running = true; this.pump();
  }
  objectStore(name: string) {
    if (!this.objectStoreNames.contains(name)) throw new DOMException("Unknown store", "NotFoundError");
    return new ObjectStore(this, name);
  }
  store(name: string) { return this.stores.get(name)!; }
  request(run: () => unknown, source: unknown, write = false) {
    if (this.finished) throw new DOMException("Transaction finished", "TransactionInactiveError");
    if (write && this.mode === "readonly") throw new DOMException("Read only", "ReadOnlyError");
    const request = new Request(); request.source = source; request.transaction = this;
    this.requests.push({ request, run });
    return request;
  }
  private pump() {
    queueMicrotask(() => {
      if (this.finished) return;
      const entry = this.requests.shift();
      if (!entry) {
        // Give request success handlers and their promise continuations a turn.
        queueMicrotask(() => { if (this.requests.length) this.pump(); else this.commit(); });
        return;
      }
      try {
        const failure = this.db.fail();
        if (failure) throw failure;
        entry.request.success(entry.run());
      } catch (error) {
        const failure = error instanceof DOMException ? error : new DOMException(String(error), "UnknownError");
        entry.request.error = failure; entry.request.readyState = "done";
        if (!entry.request.emit("error").defaultPrevented) { this.abortWith(failure); return; }
      }
      this.pump();
    });
  }
  private commit() {
    if (this.finished) return;
    this.finished = true;
    if (this.mode !== "readonly") for (const [name, store] of this.stores) this.db.data.stores.set(name, store);
    this.emit("complete"); this.release();
  }
  abort() { this.abortWith(new DOMException("Transaction aborted", "AbortError")); }
  private abortWith(error: DOMException) {
    if (this.finished) return;
    this.finished = true; this.error = error;
    queueMicrotask(() => { this.emit("error"); this.emit("abort"); if (this.running) this.release(); });
  }
  private release() {
    const data = this.db.data;
    if (data.active === this) data.active = undefined;
    this.db.next();
  }
}

class ObjectStore {
  constructor(readonly transaction: Transaction, readonly name: string) {}
  get keyPath() { return this.transaction.db.data.stores.get(this.name)?.keyPath ?? null; }
  get indexNames() { return names([...this.transaction.db.data.stores.get(this.name)!.indexes.keys()]); }
  private read(query?: Key | Range | null) {
    return [...this.transaction.store(this.name).values].filter(([key]) => matches(key, query)).sort(([a], [b]) => compare(a, b));
  }
  get(query: Key | Range) {
    return this.transaction.request(() => { this.countRead(); return clone(this.read(query)[0]?.[1]); }, this);
  }
  getAll(query?: Key | Range | null, count?: number) {
    return this.transaction.request(() => { this.countRead(); return clone(this.read(query).slice(0, count).map(([, value]) => value)); }, this);
  }
  getAllKeys(query?: Key | Range | null, count?: number) {
    return this.transaction.request(() => { this.countRead(); return clone(this.read(query).slice(0, count).map(([key]) => key)); }, this);
  }
  count(query?: Key | Range | null) { return this.transaction.request(() => this.read(query).length, this); }
  put(value: unknown, key?: Key) {
    const copied = clone(value);
    const actualKey = key ?? (this.keyPath ? (copied as Record<string, Key>)[this.keyPath] : undefined);
    if (actualKey === undefined) throw new DOMException("Missing key", "DataError");
    return this.transaction.request(() => {
      this.transaction.store(this.name).values.set(actualKey, copied);
      const stats = this.transaction.db.stats;
      stats.puts[this.name] = (stats.puts[this.name] ?? 0) + 1;
      stats.bytes[this.name] = (stats.bytes[this.name] ?? 0) + (JSON.stringify(copied)?.length ?? 0);
      return clone(actualKey);
    }, this, true);
  }
  delete(query: Key | Range) {
    return this.transaction.request(() => { for (const [key] of this.read(query)) this.transaction.store(this.name).values.delete(key); }, this, true);
  }
  clear() { return this.transaction.request(() => { this.transaction.store(this.name).values.clear(); }, this, true); }
  index(name: string) {
    const definition = this.transaction.db.data.stores.get(this.name)!.indexes.get(name);
    if (!definition) throw new DOMException("Unknown index", "NotFoundError");
    const entries = (query?: Key | Range | null) => this.read().filter(([, value]) => {
      const indexed = (value as Record<string, Key>)[definition.keyPath];
      return definition.multiEntry && Array.isArray(indexed) ? indexed.some((key) => matches(key, query)) : matches(indexed, query);
    });
    return {
      getAllKeys: (query?: Key | Range | null, count?: number) => this.transaction.request(() => { this.countRead(); return clone(entries(query).slice(0, count).map(([key]) => key)); }, this),
      getAll: (query?: Key | Range | null, count?: number) => this.transaction.request(() => { this.countRead(); return clone(entries(query).slice(0, count).map(([, value]) => value)); }, this),
    };
  }
  private countRead() {
    const reads = this.transaction.db.stats.reads; reads[this.name] = (reads[this.name] ?? 0) + 1;
  }
}

class Connection extends Events {
  closed = false;
  constructor(readonly name: string, readonly data: Database, readonly stats: FakeIdbStats, readonly fail: () => DOMException | undefined) { super(); }
  get version() { return this.data.version; }
  get objectStoreNames() { return names([...this.data.stores.keys()]); }
  createObjectStore(name: string, options?: IDBObjectStoreParameters) {
    if (this.data.stores.has(name)) throw new DOMException("Store exists", "ConstraintError");
    const store: Store = { keyPath: typeof options?.keyPath === "string" ? options.keyPath : undefined, values: new Map(), indexes: new Map() };
    this.data.stores.set(name, store);
    return { createIndex: (index: string, keyPath: string, parameters?: IDBIndexParameters) => { store.indexes.set(index, { keyPath, multiEntry: !!parameters?.multiEntry }); } };
  }
  transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly") {
    if (this.closed) throw new DOMException("Database closed", "InvalidStateError");
    const selected = typeof storeNames === "string" ? [storeNames] : storeNames;
    for (const name of selected) if (!this.data.stores.has(name)) throw new DOMException("Unknown store", "NotFoundError");
    const tx = new Transaction(this, mode, selected);
    this.data.pending.push(tx); queueMicrotask(() => this.next()); return tx;
  }
  next() {
    if (this.data.active) return;
    const tx = this.data.pending.shift();
    if (tx) { this.data.active = tx; tx.start(); }
  }
  close() { this.closed = true; this.data.connections.delete(this); }
}

/** Minimal IndexedDB contract used by the storage suites, with atomic serialized transactions. */
export function installFakeIndexedDb() {
  const databases = new Map<string, Database>();
  const stats: FakeIdbStats = { puts: {}, bytes: {}, reads: {} };
  let hung = false;
  const failures: string[] = [];
  const fail = () => { const name = failures.shift(); return name ? new DOMException(name, name) : undefined; };
  const factory = {
    open(name: string, version = 1) {
      const request = new Request();
      if (hung) return request;
      queueMicrotask(() => {
        let data = databases.get(name);
        const previous = data?.version ?? 0;
        if (!data) { data = { version, stores: new Map(), connections: new Set(), pending: [] }; databases.set(name, data); }
        const connection = new Connection(name, data, stats, fail); data.connections.add(connection);
        request.result = connection;
        if (previous < version) { data.version = version; request.emit("upgradeneeded", { oldVersion: previous, newVersion: version }); }
        request.success(connection);
      });
      return request;
    },
    deleteDatabase(name: string) {
      const request = new Request();
      queueMicrotask(() => {
        const failure = fail();
        if (failure) { request.error = failure; request.emit("error"); return; }
        const data = databases.get(name);
        for (const connection of data?.connections ?? []) connection.emit("versionchange", { oldVersion: data!.version, newVersion: null });
        if (data?.connections.size) { request.emit("blocked"); return; }
        databases.delete(name); request.success(undefined);
      });
      return request;
    },
    cmp: compare,
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: factory });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, writable: true, value: Range });
  return {
    stats,
    resetStats() { stats.puts = {}; stats.bytes = {}; stats.reads = {}; },
    failNext(name: string, count = 1) { failures.push(...Array<string>(count).fill(name)); },
    hangOpen() { hung = true; },
    dump(store: string): unknown[] { return clone([...databases.values()].flatMap((db) => [...(db.stores.get(store)?.values.values() ?? [])])); },
  };
}

export function installFakeChannels(): void {
  const channels = new Set<Channel>();
  class Channel extends EventTarget {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    constructor(readonly name: string) { super(); channels.add(this); }
    postMessage(value: unknown) {
      if (!channels.has(this)) throw new DOMException("Channel closed", "InvalidStateError");
      for (const other of channels) if (other !== this && other.name === this.name) {
        const copied = clone(value);
        queueMicrotask(() => {
          if (!channels.has(other)) return;
          const event = new MessageEvent("message", { data: copied });
          other.dispatchEvent(event); other.onmessage?.(event);
        });
      }
    }
    close() { channels.delete(this); }
  }
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, writable: true, value: Channel });
}
