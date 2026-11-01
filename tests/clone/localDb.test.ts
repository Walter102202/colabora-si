import { beforeEach, expect, it } from "vitest";
import { claimWorkspace, countRecords, isQuotaError, openLocalDb, readBodies, readWorkspace, StaleEpochError, STORES, wipeLocalDb, writeBatch, type PageWrite } from "@/lib/localDb";
import { splitPage } from "@/lib/pageShell";
import { b, page, row } from "./fixtures";
import { installFakeIndexedDb } from "./fakeIndexedDb";

let fake: ReturnType<typeof installFakeIndexedDb>;
beforeEach(() => { fake = installFakeIndexedDb(); });
const full = (id = "p", revision = 1): Extract<PageWrite, { kind: "full" }> => ({
  kind: "full", id, ...splitPage(page({ id, revision, blocks: [b("paragraph", { html: "body" })] })), search: { id, text: "body", comments: "" },
});
async function seeded() {
  const db = await openLocalDb();
  await claimWorkspace(db, [full()], [["rootOrder", ["p"]]], 123);
  return { db, ...(await readWorkspace(db)) };
}

it("creates the four stores and the multi-entry links index", async () => {
  const db = await openLocalDb();
  expect([...db.objectStoreNames]).toEqual([...STORES]);
  const write = full(); write.meta.links = ["x", "y"];
  await claimWorkspace(db, [write], [], null);
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction("meta").objectStore("meta").index("links").getAllKeys("x");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  expect(keys).toEqual(["p"]);
});

it("claims once atomically, preserves kv, and makes simultaneous claims converge", async () => {
  const db = await openLocalDb();
  expect(await Promise.all([claimWorkspace(db, [full()], [["rootOrder", ["p"]]], 123), claimWorkspace(db, [full("other")], [], 456)])).toEqual(["created", "existing"]);
  const state = await readWorkspace(db);
  expect(state.metas.map((meta) => meta.id)).toEqual(["p"]);
  expect(state.kv).toMatchObject({ rootOrder: ["p"], schema: 1, migratedAt: 123, epoch: state.epoch });
  expect(state.epoch).toEqual(expect.any(String));
  expect(await countRecords(db)).toEqual({ meta: 1, bodies: 1 });
  expect((await readBodies(db, ["p", "missing"])).get("p")?.blocks[0].html).toBe("body");
  fake.resetStats();
  expect(await claimWorkspace(db, [full("ignored")], [], null)).toBe("existing");
  expect(fake.stats.puts).toEqual({});
});

it("rolls back a claim when a later body cannot be cloned", async () => {
  const db = await openLocalDb(), invalid = full("bad");
  Object.assign(invalid.body, { invalid: () => undefined });
  await expect(claimWorkspace(db, [full(), invalid], [["settings", {}]], null)).rejects.toBeTruthy();
  for (const store of STORES) expect(fake.dump(store)).toEqual([]);
});

it("rejects stale epochs without writing pages or kv", async () => {
  const { db } = await seeded(); fake.resetStats();
  await expect(writeBatch(db, "stale", { pages: [full("other")], kv: [["rootOrder", []]] })).rejects.toBeInstanceOf(StaleEpochError);
  expect(fake.stats.puts).toEqual({});
  expect((await readWorkspace(db)).kv.rootOrder).toEqual(["p"]);
});

it("updates metadata without touching the body revision, links, or body; removes rowOrigin", async () => {
  const { db, epoch } = await seeded();
  const write = full(); write.meta.links = ["x"]; write.meta.rowOrigin = { databasePageId: "db", row: row({ title: "Archived" }, "p"), index: 0 };
  await writeBatch(db, epoch, { pages: [write], kv: [] }); fake.resetStats();
  const meta = { ...full().meta, title: "Renamed", revision: 8 };
  await writeBatch(db, epoch, { pages: [{ kind: "meta", id: "p", meta }], kv: [] });
  const stored = (await readWorkspace(db)).metas[0];
  expect(stored).toMatchObject({ title: "Renamed", revision: 8, bodyRev: 1, links: ["x"] });
  expect(stored.rowOrigin).toBeUndefined();
  expect(fake.stats.puts.bodies ?? 0).toBe(0);
  expect((await readBodies(db, ["p"])).get("p")?.blocks[0].html).toBe("body");
});

it("creates metadata-only pages with no body revision or references", async () => {
  const { db, epoch } = await seeded();
  const { bodyRev, links, ...meta } = full("shell").meta; void bodyRev; void links;
  await writeBatch(db, epoch, { pages: [{ kind: "meta", id: "shell", meta }], kv: [] });
  expect((await readWorkspace(db)).metas.find((entry) => entry.id === "shell")).toMatchObject({ bodyRev: null, links: [] });
  expect((await readBodies(db, ["shell"])).has("shell")).toBe(false);
});

it("ignores older remote bodies but accepts a local replacement", async () => {
  const { db, epoch } = await seeded();
  await writeBatch(db, epoch, { pages: [full("p", 5)], kv: [] }); fake.resetStats();
  await writeBatch(db, epoch, { pages: [{ ...full("p", 2), remote: true }], kv: [] });
  expect(fake.stats.puts).toEqual({});
  expect((await readWorkspace(db)).metas[0].bodyRev).toBe(5);
  await writeBatch(db, epoch, { pages: [full("p", 2)], kv: [] });
  expect((await readWorkspace(db)).metas[0].bodyRev).toBe(2);
});

it("deletes all three page records and writes kv in the same batch", async () => {
  const { db, epoch } = await seeded();
  await writeBatch(db, epoch, { pages: [{ kind: "delete", id: "p" }], kv: [["rootOrder", []]] });
  for (const store of ["meta", "bodies", "search"]) expect(fake.dump(store)).toEqual([]);
  expect((await readWorkspace(db)).kv.rootOrder).toEqual([]);
});

it("reports quota errors and leaves a failed batch unchanged", async () => {
  const { db, epoch } = await seeded();
  fake.failNext("QuotaExceededError");
  await expect(writeBatch(db, epoch, { pages: [full("other")], kv: [["rootOrder", []]] })).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect((await readWorkspace(db)).metas.map((meta) => meta.id)).toEqual(["p"]);
  expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
  expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
  expect(isQuotaError(null)).toBe(false); expect(isQuotaError(new Error("other"))).toBe(false);
});

it("wipes atomically and replaces the epoch so queued old writes cannot resurrect pages", async () => {
  const { db, epoch } = await seeded();
  await wipeLocalDb(db, "new-epoch");
  expect(await readWorkspace(db)).toEqual({ metas: [], kv: { schema: 1, epoch: "new-epoch" }, epoch: "new-epoch" });
  expect(await countRecords(db)).toEqual({ meta: 0, bodies: 0 });
  expect(fake.dump("search")).toEqual([]);
  await expect(writeBatch(db, epoch, { pages: [full()], kv: [] })).rejects.toBeInstanceOf(StaleEpochError);
  expect(await countRecords(db)).toEqual({ meta: 0, bodies: 0 });
});
