// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/lib/store";
import { foreignPageIds } from "@/lib/foreignPages";
import { applyingExternal } from "@/lib/externalApply";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { diskAvailable, flushLocalWrites, hasPendingLocalWrites, persistFull, startWriter } from "@/lib/localPersistence";
import { shellOf, splitPage } from "@/lib/pageShell";
import { searchRecord } from "@/lib/search";
import { b, db, page, prop, row } from "./fixtures";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import type { Page } from "@/lib/types";

let fake: ReturnType<typeof installFakeIndexedDb>, stop: (() => void) | undefined;
const original = () => page({ id: "a", blocks: [b("paragraph", { id: "block", html: "original" })] });
const putPage = (value: Page) => useStore.setState((state) => ({ pages: { ...state.pages, [value.id]: value } }));
async function setup(pages: Page[] = [original()]) {
  stop?.(); fake = installFakeIndexedDb(); foreignPageIds.clear();
  useStore.setState({ pages: Object.fromEntries(pages.map((p) => [p.id, p])), rootOrder: pages.map((p) => p.id), expanded: {}, syncedBlocks: {}, reminders: [], syncUserId: null, syncWorkspaceId: null });
  const db = await openLocalDb();
  await claimWorkspace(db, pages.map((p) => ({ kind: "full", id: p.id, ...splitPage(p), search: searchRecord(p, {}) })), [], null);
  const { epoch } = await readWorkspace(db);
  stop = startWriter(db, epoch); fake.resetStats();
  return { db, epoch };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); foreignPageIds.clear(); });

it("writes only the edited page and coalesces a fixed 300ms window", async () => {
  await setup([original(), page({ id: "other" })]);
  for (let i = 0; i < 10; i++) useStore.getState().updateBlock("a", "block", { html: String(i) });
  expect(fake.stats.puts.bodies).toBeUndefined();
  await vi.advanceTimersByTimeAsync(250);
  useStore.getState().updateBlock("a", "block", { html: "latest" });
  await vi.advanceTimersByTimeAsync(50);
  expect(fake.stats.puts).toEqual({ meta: 1, bodies: 1, search: 1 });
  expect(fake.dump("bodies")).toContainEqual(expect.objectContaining({ id: "a", blocks: [expect.objectContaining({ html: "latest" })] }));
  expect(hasPendingLocalWrites()).toBe(false);
});

it("writes preferences alone and never persists identity lists", async () => {
  await setup();
  useStore.getState().setExpanded("a", true);
  await flushLocalWrites();
  expect(fake.stats.puts).toEqual({ kv: 1 });
  expect(fake.dump("kv")).toContainEqual({ a: true });
  expect((await readWorkspace(await openLocalDb())).kv).not.toHaveProperty("members");
  expect((await readWorkspace(await openLocalDb())).kv).not.toHaveProperty("agents");
});

it("creates and removes all page records", async () => {
  await setup(); putPage(page({ id: "new" })); await flushLocalWrites();
  expect(fake.dump("bodies")).toHaveLength(2);
  useStore.setState(({ pages }) => ({ pages: { a: pages.a } })); await flushLocalWrites();
  for (const store of ["meta", "bodies", "search"]) expect(fake.dump(store)).toEqual([expect.objectContaining({ id: "a" })]);
});

it("excludes foreign pages through their whole mounted lifetime", async () => {
  await setup(); foreignPageIds.add("shared");
  putPage(page({ id: "shared" })); await flushLocalWrites();
  useStore.setState(({ pages }) => ({ pages: { a: pages.a } })); foreignPageIds.delete("shared");
  await flushLocalWrites();
  expect(fake.stats.puts).toEqual({});
  expect(fake.dump("meta")).toEqual([expect.objectContaining({ id: "a" })]);
});

it("does not write an external body load but writes an imported replacement", async () => {
  await setup();
  applyingExternal(() => putPage(shellOf(original()))); await flushLocalWrites(); fake.resetStats();
  applyingExternal(() => putPage(original())); await flushLocalWrites();
  expect(fake.stats.puts).toEqual({});
  applyingExternal(() => putPage(shellOf(original())));
  putPage({ ...original(), blocks: [b("paragraph", { html: "imported" })] });
  await flushLocalWrites();
  expect(fake.stats.puts.bodies).toBe(1);
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "imported" }] });
});

it("writes shell metadata without replacing stored bodies", async () => {
  await setup(); applyingExternal(() => putPage(shellOf(original())));
  putPage({ ...useStore.getState().pages.a, title: "new title" }); await flushLocalWrites();
  expect(fake.stats.puts).toEqual({ meta: 1 });
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "original" }] });
});

it("retains a queued remote body when newer shell metadata follows it", async () => {
  await setup(); applyingExternal(() => putPage(shellOf(original())));
  persistFull([{ ...original(), blocks: [b("paragraph", { html: "downloaded" })] }]);
  putPage({ ...useStore.getState().pages.a, title: "new title" }); await flushLocalWrites();
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "downloaded" }] });
  expect(fake.dump("meta")[0]).toMatchObject({ title: "new title" });
});

it("keeps failed changes pending and retries without replacing newer edits", async () => {
  await setup();
  useStore.getState().updateBlock("a", "block", { html: "failed" });
  fake.failNext("QuotaExceededError");
  const failed = flushLocalWrites();
  useStore.getState().updateBlock("a", "block", { html: "newer" });
  await expect(failed).rejects.toHaveProperty("name", "QuotaExceededError");
  expect(hasPendingLocalWrites()).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "newer" }] });
  expect(hasPendingLocalWrites()).toBe(false);
});

it("drains writes added while a flush is in flight", async () => {
  await setup(); useStore.getState().updateBlock("a", "block", { html: "first" });
  const flush = flushLocalWrites();
  useStore.getState().updateBlock("a", "block", { html: "second" });
  await flush;
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "second" }] });
  expect(hasPendingLocalWrites()).toBe(false);
});

it("retains a failed downloaded body beneath a newer pending metadata edit", async () => {
  await setup(); applyingExternal(() => putPage(shellOf(original())));
  persistFull([{ ...original(), blocks: [b("paragraph", { html: "downloaded" })] }]);
  fake.failNext("QuotaExceededError");
  const failed = flushLocalWrites();
  putPage({ ...useStore.getState().pages.a, title: "new metadata" });
  await expect(failed).rejects.toHaveProperty("name", "QuotaExceededError");
  await flushLocalWrites();
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "downloaded" }] });
  expect(fake.dump("meta")[0]).toMatchObject({ title: "new metadata" });
});

it("flushes on pagehide and hidden visibility changes", async () => {
  await setup(); useStore.getState().updateBlock("a", "block", { html: "hidden" });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange")); await flushLocalWrites();
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "hidden" }] });
  useStore.getState().updateBlock("a", "block", { html: "leaving" });
  window.dispatchEvent(new Event("pagehide")); await flushLocalWrites();
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "leaving" }] });
});

it("replaces the prior subscription and discards its pending generation", async () => {
  const { db, epoch } = await setup();
  useStore.getState().updateBlock("a", "block", { html: "old pending" });
  stop = startWriter(db, epoch);
  expect(diskAvailable()).toBe(true);
  expect(hasPendingLocalWrites()).toBe(false);
  useStore.getState().updateBlock("a", "block", { html: "current" }); await flushLocalWrites();
  expect(fake.stats.puts.bodies).toBe(1);
});

it("chunks large imports without leaving work behind", async () => {
  const { db } = await setup([]), transaction = vi.spyOn(db, "transaction");
  useStore.setState({ pages: Object.fromEntries(Array.from({ length: 401 }, (_, i) => { const p = page({ id: `p${i}` }); return [p.id, p]; })) });
  await flushLocalWrites();
  expect(transaction.mock.calls.filter(([, mode]) => mode === "readwrite")).toHaveLength(3);
  expect(fake.stats.puts.bodies).toBe(401);
});

it("indexes body, comments, synced text and eligible row cells with bounded text", () => {
  const p = page({ id: "database", blocks: [b("synced", { syncedFrom: "source" })], comments: [{ id: "comment", author: "Person", authorId: "person", authorType: "human", body: "c".repeat(70_000), createdAt: 1 }], database: db([prop({ id: "text", type: "text" }), prop({ id: "number", type: "number" })], [row({ text: "find me", number: 42 }, "row-page")]) });
  const record = searchRecord(p, { source: [b("paragraph", { html: "x".repeat(70_000) })] });
  expect(record.text).toHaveLength(65536); expect(record.comments).toHaveLength(65536);
  expect(record.cells).toEqual({ "row-page": "find me" });
});
