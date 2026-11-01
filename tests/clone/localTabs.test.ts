// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeChannels, installFakeIndexedDb } from "./fakeIndexedDb";
import { b, page } from "./fixtures";

interface Tab {
  storage: typeof import("@/lib/localPersistence");
  store: typeof import("@/lib/store").useStore;
  history: typeof import("@/lib/history");
  sync: typeof import("@/lib/sync");
}
const tabs: Tab[] = [];
let fake: ReturnType<typeof installFakeIndexedDb>;
async function tab(first = false) {
  vi.resetModules();
  const storage = await import("@/lib/localPersistence"), store = (await import("@/lib/store")).useStore;
  if (first) store.setState({ pages: { p: page({ id: "p", blocks: [b("paragraph", { id: "x", html: "X" }), b("paragraph", { id: "y", html: "Y" })] }) }, rootOrder: ["p"], syncWorkspaceId: null, syncUserId: null });
  await storage.hydrateWorkspace();
  const history = await import("@/lib/history"), sync = await import("@/lib/sync");
  const value = { storage, store, history, sync }; tabs.push(value); return value;
}
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const edit = (tab: Tab, id: string, html: string) => tab.store.getState().updateBlock("p", id, { html });
const texts = (tab: Tab) => tab.store.getState().pages.p.blocks.map((block) => block.html);
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); fake = installFakeIndexedDb(); installFakeChannels(); });
afterEach(() => { for (const tab of tabs.splice(0)) { tab.storage.stopLocalPersistence(); tab.sync.stopSync(); } vi.restoreAllMocks(); vi.useRealTimers(); });

it("reloads peer edits without writing them back, making history or enqueuing cloud operations", async () => {
  const a = await tab(true), peer = await tab(); peer.history.initHistory(); peer.history.clearHistory();
  const queued: string[] = [];
  const unsubscribe = peer.store.subscribe((state, prev) => { if (state.pages !== prev.pages && !peer.sync.isApplyingRemote()) queued.push("local edit"); });
  fake.resetStats(); edit(a, "x", "A"); await a.storage.flushLocalWrites(); await settle();
  expect(texts(peer)).toEqual(["A", "Y"]); expect(queued).toEqual([]); expect(peer.history.canUndo()).toBe(false);
  expect(fake.stats.puts.bodies).toBe(1); await vi.advanceTimersByTimeAsync(2500);
  expect(fake.stats.puts.bodies).toBe(1); unsubscribe();
});

it("propagates new full pages, permanent removals and shared preferences, but not expanded or identity", async () => {
  const a = await tab(true), peer = await tab();
  const id = a.store.getState().createPage(null, { title: "Created", blocks: [b("paragraph", { html: "body" })] });
  a.store.getState().setExpanded("p", true); a.store.getState().setSyncWorkspaceId("private", "person");
  await a.storage.flushLocalWrites(); await settle();
  expect(peer.store.getState().pages[id].blocks[0].html).toBe("body"); expect(peer.store.getState().rootOrder).toContain(id);
  expect(peer.store.getState().expanded.p).toBeUndefined(); expect(peer.store.getState().syncUserId).toBeNull();
  a.store.setState(({ pages }) => ({ pages: { p: pages.p }, rootOrder: ["p"] }));
  await a.storage.flushLocalWrites(); await settle();
  expect(peer.store.getState().pages[id]).toBeUndefined(); expect(peer.store.getState().rootOrder).toEqual(["p"]);
});

it.each([false, true])("preserves two concurrent block edits with simultaneous flushes (reverse=%s)", async (reverse) => {
  const a = await tab(true), peer = await tab(); fake.resetStats();
  edit(a, "x", "A"); edit(peer, "y", "B");
  await Promise.all((reverse ? [peer, a] : [a, peer]).map((tab) => tab.storage.flushLocalWrites()));
  await vi.advanceTimersByTimeAsync(2100); await settle();
  expect(texts(a)).toEqual(["A", "B"]); expect(texts(peer)).toEqual(["A", "B"]);
  expect(fake.dump("bodies")[0]).toMatchObject({ blocks: [{ html: "A" }, { html: "B" }] });
  const writes = fake.stats.puts.bodies;
  await vi.advanceTimersByTimeAsync(5000); expect(fake.stats.puts.bodies).toBe(writes);
});

it("preserves an edit made while its earlier transaction is in flight", async () => {
  const a = await tab(true), peer = await tab();
  edit(a, "x", "A"); edit(peer, "y", "B");
  const pending = Promise.all([a.storage.flushLocalWrites(), peer.storage.flushLocalWrites()]);
  edit(peer, "y", "B later"); await pending;
  await vi.advanceTimersByTimeAsync(2100);
  expect(texts(a)).toEqual(["A", "B later"]); expect(texts(peer)).toEqual(["A", "B later"]);
});

it("defers a peer update while the page is being edited and applies it after two seconds", async () => {
  const a = await tab(true), peer = await tab();
  edit(peer, "y", "B"); await peer.storage.flushLocalWrites(); await settle();
  edit(a, "x", "A"); await a.storage.flushLocalWrites(); await settle();
  expect(texts(peer)).toEqual(["X", "B"]);
  await vi.advanceTimersByTimeAsync(1999); expect(texts(peer)).toEqual(["X", "B"]);
  await vi.advanceTimersByTimeAsync(1); await settle(); expect(texts(peer)).toEqual(["A", "B"]);
});

it("retries a failed local diff against the peer's newer body", async () => {
  const a = await tab(true), peer = await tab();
  edit(a, "x", "A"); fake.failNext("QuotaExceededError");
  await expect(a.storage.flushLocalWrites()).rejects.toHaveProperty("name", "QuotaExceededError");
  edit(peer, "y", "B"); await peer.storage.flushLocalWrites();
  await a.storage.flushLocalWrites(); await vi.advanceTimersByTimeAsync(2100);
  expect(texts(a)).toEqual(["A", "B"]); expect(texts(peer)).toEqual(["A", "B"]);
});

it("reloads another tab after clearing and stops its pending writer", async () => {
  const a = await tab(true), peer = await tab(), reload = vi.spyOn(location, "reload").mockImplementation(() => {});
  edit(peer, "y", "pending old account"); a.store.getState().clearLocalWorkspace();
  await a.storage.clearLocalPages(); await settle();
  expect(reload).toHaveBeenCalled(); expect(peer.storage.diskAvailable()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(JSON.stringify(fake.dump("bodies"))).not.toContain("pending old account");
});

it("reloads on a stale epoch even without BroadcastChannel", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const a = await tab(true), peer = await tab(), reload = vi.spyOn(location, "reload").mockImplementation(() => {});
  a.store.getState().clearLocalWorkspace(); await a.storage.clearLocalPages(); edit(peer, "x", "obsolete");
  await expect(peer.storage.flushLocalWrites()).rejects.toThrow("stale_local_epoch");
  expect(reload).toHaveBeenCalled(); expect(peer.storage.diskAvailable()).toBe(false); vi.unstubAllGlobals();
});

it("keeps saving without BroadcastChannel and reads the latest copy next boot", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const a = await tab(true); edit(a, "x", "offline browser"); await a.storage.flushLocalWrites();
  const peer = await tab(); expect(texts(peer)).toEqual(["offline browser", "Y"]); vi.unstubAllGlobals();
});

it("keeps a new page edited before its first disk write", async () => {
  const a = await tab(true);
  const id = a.store.getState().createPage(null, { title: "New", blocks: [b("paragraph", { id: "new-block", html: "First" })] });
  a.store.getState().updateBlock(id, "new-block", { html: "Edited before first save" });
  await a.storage.flushLocalWrites();
  expect(a.store.getState().pages[id]?.blocks[0].html).toBe("Edited before first save");
  expect(fake.dump("bodies")).toContainEqual(expect.objectContaining({ id, blocks: [expect.objectContaining({ html: "Edited before first save" })] }));
});
