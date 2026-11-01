// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeChannels, installFakeIndexedDb } from "./fakeIndexedDb";

const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error);
});
async function open() {
  const request = indexedDB.open("test", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("pages", { keyPath: "id" }).createIndex("links", "links", { multiEntry: true });
    request.result.createObjectStore("kv");
  };
  return result(request);
}

describe("IndexedDB double", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });

  it("rolls back all writes in an aborted transaction", async () => {
    const db = await open(), tx = db.transaction(["pages", "kv"], "readwrite"), done = complete(tx);
    tx.objectStore("pages").put({ id: "a" });
    tx.objectStore("kv").put("value", "key");
    tx.abort();
    await expect(done).rejects.toHaveProperty("name", "AbortError");
    expect(fake.dump("pages")).toEqual([]);
    expect(fake.dump("kv")).toEqual([]);
  });

  it("serializes transactions and exposes committed data to the next one", async () => {
    const db = await open(), first = db.transaction("pages", "readwrite"), one = complete(first);
    first.objectStore("pages").put({ id: "a", value: 1 });
    const second = db.transaction("pages", "readwrite"), two = complete(second);
    const read = result(second.objectStore("pages").get("a"));
    expect(await read).toEqual({ id: "a", value: 1 });
    await Promise.all([one, two]);
  });

  it("supports keys, ranges, limits, count, indexes, delete and clear", async () => {
    const db = await open(), tx = db.transaction("pages", "readwrite"), done = complete(tx);
    for (const id of ["c", "a", "b"]) tx.objectStore("pages").put({ id, links: id === "b" ? ["y"] : ["x", "x"] });
    await done;
    const read = db.transaction("pages"), store = read.objectStore("pages"), readDone = complete(read);
    const values = result(store.getAll(IDBKeyRange.lowerBound("a", true), 1));
    const keys = result(store.getAllKeys());
    const count = result(store.count());
    const links = result(store.index("links").getAllKeys("x"));
    expect(await values).toEqual([{ id: "b", links: ["y"] }]);
    expect(await keys).toEqual(["a", "b", "c"]);
    expect(await count).toBe(3);
    expect(await links).toEqual(["a", "c"]);
    await readDone;
    const remove = db.transaction("pages", "readwrite"), removed = complete(remove);
    remove.objectStore("pages").delete("b");
    await removed;
    expect(fake.dump("pages")).toHaveLength(2);
    const clear = db.transaction("pages", "readwrite"), cleared = complete(clear);
    clear.objectStore("pages").clear();
    await cleared;
    expect(fake.dump("pages")).toEqual([]);
  });

  it("clones writes and reads, drops symbols and counts bytes and reads", async () => {
    const db = await open(), mark = Symbol("shell"), value = { id: "a", nested: { text: "original" }, [mark]: true };
    const tx = db.transaction("pages", "readwrite"), done = complete(tx);
    tx.objectStore("pages").put(value);
    value.nested.text = "changed";
    await done;
    const read = await result(db.transaction("pages").objectStore("pages").get("a"));
    expect(read).toEqual({ id: "a", nested: { text: "original" } });
    read.nested.text = "changed again";
    expect(fake.dump("pages")).toEqual([{ id: "a", nested: { text: "original" } }]);
    expect(fake.stats.puts.pages).toBe(1);
    expect(fake.stats.bytes.pages).toBe(JSON.stringify({ id: "a", nested: { text: "original" } }).length);
    expect(fake.stats.reads.pages).toBe(1);
    fake.resetStats();
    expect(fake.stats).toEqual({ puts: {}, bytes: {}, reads: {} });
  });

  it("aborts a quota failure without leaving earlier writes behind", async () => {
    const db = await open(), tx = db.transaction("pages", "readwrite"), done = complete(tx);
    tx.objectStore("pages").put({ id: "a" }).onsuccess = () => {
      fake.failNext("QuotaExceededError");
      tx.objectStore("pages").put({ id: "b" });
    };
    await expect(done).rejects.toHaveProperty("name", "QuotaExceededError");
    expect(fake.dump("pages")).toEqual([]);
  });

  it("can hold opening without completing or upgrading", async () => {
    fake.hangOpen();
    const request = indexedDB.open("hung");
    let settled = false;
    request.onsuccess = request.onerror = request.onupgradeneeded = () => { settled = true; };
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("delivers cloned messages to other open channels only", async () => {
    installFakeChannels();
    const a = new BroadcastChannel("pages"), b = new BroadcastChannel("pages"), other = new BroadcastChannel("elsewhere");
    const received: unknown[] = [];
    a.onmessage = () => received.push("self");
    b.onmessage = (event) => received.push(event.data);
    other.onmessage = () => received.push("other");
    const message = { title: "before" };
    a.postMessage(message); message.title = "after";
    await Promise.resolve();
    expect(received).toEqual([{ title: "before" }]);
    b.close(); a.postMessage("closed");
    await Promise.resolve();
    expect(received).toHaveLength(1);
    a.close(); other.close();
  });
});
