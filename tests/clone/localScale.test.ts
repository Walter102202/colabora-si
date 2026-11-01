// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { Page } from "@/lib/types";
import { installFakeIndexedDb, type FakeIdbStats } from "./fakeIndexedDb";

const NOW = 1_700_000_000_000;
const SIZES = [100, 1000, 10_000];
function makePages(size: number): Page[] {
  return Array.from({ length: size }, (_, index) => {
    const suffix = String(index).padStart(5, "0");
    return { id: `page-${suffix}`, title: `Page ${suffix}`, parentId: null, icon: null, cover: null,
      isFavorite: false, isDeleted: false, fullWidth: false, smallText: false, createdAt: NOW, updatedAt: NOW,
      blocks: [{ id: `block-${suffix}`, type: "paragraph", html: "x".repeat(2048), indent: 0 }] };
  });
}
async function measure(size: number, editedPages = 1): Promise<{ size: number; startupBodyReads: number; openBodyReads: number; stats: FakeIdbStats; legacyBytes: number }> {
  (await import("@/lib/localPersistence")).stopLocalPersistence(); vi.resetModules(); localStorage.clear();
  const fake = installFakeIndexedDb(), storage = await import("@/lib/localPersistence"), adapter = await import("@/lib/localDb");
  const { useStore } = await import("@/lib/store"), { ensurePageBodies } = await import("@/lib/pageBodies");
  const pages = makePages(size), rootOrder = pages.map((page) => page.id), connection = await adapter.openLocalDb();
  await adapter.claimWorkspace(connection, pages.map((page) => storage.fullWrite(page)), [["rootOrder", rootOrder]], null);
  connection.close(); fake.resetStats(); await storage.hydrateWorkspace();
  const startupBodyReads = fake.stats.reads.bodies ?? 0;
  await ensurePageBodies(pages.slice(0, editedPages).map((page) => page.id));
  const openBodyReads = (fake.stats.reads.bodies ?? 0) - startupBodyReads;
  fake.resetStats();
  for (const page of pages.slice(0, editedPages)) useStore.getState().updateBlock(page.id, page.blocks[0].id, { html: "edited" });
  await storage.flushLocalWrites();
  const stats = structuredClone(fake.stats);
  const legacyBytes = JSON.stringify({ state: { pages: Object.fromEntries(pages.map((page) => [page.id, page])), rootOrder, expanded: {} }, version: 1 }).length;
  storage.stopLocalPersistence();
  return { size, startupBodyReads, openBodyReads, stats, legacyBytes };
}
afterEach(async () => { (await import("@/lib/localPersistence")).stopLocalPersistence(); vi.restoreAllMocks(); });

it("builds the same fixed-size editable page at every workspace size", () => {
  const results = SIZES.map((size) => makePages(size));
  expect(results.map((pages) => pages.length)).toEqual(SIZES);
  expect(results[0][0]).toEqual(results[1][0]); expect(results[1][0]).toEqual(results[2][0]);
  expect(new Set(results[2].map((page) => page.id)).size).toBe(10_000);
});

it("writes identical puts and bytes per edit at 100, 1000 and 10000 pages", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const results = [];
  for (const size of SIZES) results.push(await measure(size));
  for (const result of results) {
    expect(result.startupBodyReads).toBe(0); expect(result.openBodyReads).toBe(1);
    expect(result.stats.puts).toEqual({ meta: 1, bodies: 1, search: 1 });
    expect(result.stats.puts).toEqual(results[0].stats.puts);
    expect(result.stats.bytes).toEqual(results[0].stats.bytes);
  }
  expect(results[2].legacyBytes).toBeGreaterThan(results[0].legacyBytes * 90);
  process.stdout.write(`Local write scale: ${JSON.stringify(results)}\n`);
}, 30_000);

it("writes three records per page store for three edited pages in a 10000-page workspace", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const result = await measure(10_000, 3);
  expect(result.startupBodyReads).toBe(0); expect(result.openBodyReads).toBe(3);
  expect(result.stats.puts).toEqual({ meta: 3, bodies: 3, search: 3 });
}, 30_000);
