// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { backlinkIds } from "@/lib/pageBodies";
import { useBacklinks } from "@/lib/usePageBodies";
import { useStore } from "@/lib/store";
import { applyingExternal } from "@/lib/externalApply";
import { shellOf } from "@/lib/pageShell";
import { fullWrite, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import { claimWorkspace, openLocalDb, readWorkspace, writeBatch } from "@/lib/localDb";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import type { Page } from "@/lib/types";
import { b, column, db, page, prop, row } from "./fixtures";

let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; stopLocalPersistence(); vi.useRealTimers(); });
async function setup(pages: Page[], loaded = false) {
  stopLocalPersistence(); const fake = installFakeIndexedDb();
  applyingExternal(() => useStore.setState({ pages: Object.fromEntries(pages.map((p) => [p.id, loaded ? p : shellOf(p)])), rootOrder: pages.map((p) => p.id) }));
  const connection = await openLocalDb(); await claimWorkspace(connection, pages.map((p) => fullWrite(p)), [], null);
  const { epoch } = await readWorkspace(connection); startWriter(connection, epoch); fake.resetStats();
  return { fake, connection, epoch };
}

it("finds page, database, HTML, column and relation backlinks without reading bodies", async () => {
  const target = page({ id: "target", blocks: [b("page", { pageId: "target" })] });
  const sources = [
    page({ id: "page", blocks: [b("page", { pageId: target.id })] }),
    page({ id: "database", blocks: [b("database", { pageId: target.id })] }),
    page({ id: "html", blocks: [b("paragraph", { html: '<a href="/p/target">Target</a>' })] }),
    page({ id: "column", blocks: [b("columns", { columns: [column([b("page", { pageId: target.id })])] })] }),
    page({ id: "relation", database: db([prop({ id: "rel", type: "relation" })], [row({ rel: [target.id] })]) }),
  ];
  const deleted = page({ id: "deleted", isDeleted: true, blocks: sources[0].blocks });
  const { fake } = await setup([target, ...sources, deleted]);
  expect((await backlinkIds(target.id)).sort()).toEqual(sources.map((p) => p.id).sort());
  expect(fake.stats.reads.bodies ?? 0).toBe(0);
});

it("flushes an edited reference before reading its updated index", async () => {
  const target = page({ id: "target" }), source = page({ id: "source", blocks: [b("page", { pageId: target.id })] });
  const { fake } = await setup([target, source], true);
  expect(await backlinkIds(target.id)).toEqual([source.id]);
  useStore.getState().setBlocks(source.id, []);
  expect(await backlinkIds(target.id)).toEqual([]);
  // The writer reads the edited body to reconcile peers; the index lookup does not.
  fake.resetStats();
  expect(await backlinkIds(target.id)).toEqual([]);
  expect(fake.stats.reads.bodies ?? 0).toBe(0);
});

it("falls back to loaded memory when no local disk is available", async () => {
  stopLocalPersistence();
  const target = page({ id: "target" }), source = page({ id: "source", blocks: [b("page", { pageId: target.id })] });
  useStore.setState({ pages: { target, source } });
  expect(await backlinkIds(target.id)).toEqual([source.id]);
});

it("refreshes open backlinks after peer metadata changes without reading a body", async () => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const target = page({ id: "target" }), source = page({ id: "source", blocks: [b("page", { pageId: target.id })] });
  const { fake, connection, epoch } = await setup([target, source]);
  function References() { return createElement("output", {}, useBacklinks(target.id).map((p) => p.id).join(",")); }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(createElement(References)));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(host.textContent).toBe(source.id);
  const updated = { ...source, blocks: [] };
  await writeBatch(connection, epoch, { pages: [fullWrite(updated)], kv: [] }); fake.resetStats();
  act(() => applyingExternal(() => useStore.getState().applyLocalPages({ pages: { source: shellOf(updated) } })));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(host.textContent).toBe(""); expect(fake.stats.reads.bodies ?? 0).toBe(0);
});

it("does not force the writer to flush on each keystroke", async () => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const target = page({ id: "target" }), source = page({ id: "source", blocks: [b("paragraph", { id: "block" })] });
  const { fake } = await setup([target, source], true);
  function References() { return createElement("output", {}, useBacklinks(target.id).length); }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(createElement(References)));
  for (let i = 0; i < 5; i++) {
    act(() => useStore.getState().updateBlock(source.id, "block", { html: `Typing ${i}` }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  }
  expect(fake.stats.puts).toEqual({});
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(fake.stats.puts.bodies).toBe(1);
});
