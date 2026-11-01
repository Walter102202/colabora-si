// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { searchStoredPages, mergeHits } from "@/lib/localSearch";
import { rankLocal } from "@/lib/search";
import { fullWrite, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { shellOf } from "@/lib/pageShell";
import { useStore } from "@/lib/store";
import type { Page } from "@/lib/types";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, db, page, prop, row } from "./fixtures";

afterEach(() => stopLocalPersistence());
async function setup(pages: Page[]) {
  stopLocalPersistence(); const fake = installFakeIndexedDb(), connection = await openLocalDb();
  const shells = Object.fromEntries(pages.map((p) => [p.id, shellOf(p)]));
  useStore.setState({ pages: shells, syncedBlocks: {} });
  await claimWorkspace(connection, pages.map((p) => fullWrite(p)), [], null);
  startWriter(connection, (await readWorkspace(connection)).epoch); fake.resetStats();
  return { fake, shells };
}

it.each(["a-database", "z-database"])("matches combined rankLocal scores when %s is scanned before or after its row", async (databaseId) => {
  const p = page({ id: "row", parentId: databaseId, title: "Needle title", blocks: [b("paragraph", { html: "Body needle text" })], comments: [{ id: "comment", body: "Comment needle", authorId: "person", authorType: "human", createdAt: 1 }] });
  const database = page({ id: databaseId, database: db([prop({ id: "notes", type: "text" })], [row({ notes: "Cell needle" }, "row")]) });
  const { fake, shells } = await setup([p, database]);
  const hits = await searchStoredPages(shells, "needle");
  expect(hits).toEqual(rankLocal({ row: p, [databaseId]: database }, {}, "needle"));
  expect(hits[0]).toMatchObject({ pageId: "row", score: 24, snippet: "Body needle text", kind: "row" });
  expect(fake.stats.reads.bodies ?? 0).toBe(0);
  expect(rankLocal(shells, {}, "needle")[0].score).toBe(15);
});

it("returns independent body/comment/cell hits and ignores deleted or missing metadata", async () => {
  const body = page({ id: "body", blocks: [b("paragraph", { html: "findme body" })] });
  const comment = page({ id: "comment", comments: [{ id: "c", body: "findme comment", authorId: "person", authorType: "human", createdAt: 1 }] });
  const cell = page({ id: "cell", parentId: "db" });
  const database = page({ id: "db", database: db([prop({ id: "notes", type: "text" })], [row({ notes: "findme cell" }, "cell")]) });
  const deleted = page({ id: "deleted", title: "findme", isDeleted: true }), absent = page({ id: "absent", title: "findme" });
  const { shells } = await setup([body, comment, cell, database, deleted, absent]); delete shells.absent;
  expect((await searchStoredPages(shells, "findme")).map((hit) => [hit.pageId, hit.score, hit.snippet])).toEqual([["cell", 4, "findme cell"], ["body", 3, "findme body"], ["comment", 2, "findme comment"]]);
});

it("merges by page identity using the higher score exactly once", () => {
  const base = { kind: "page" as const, id: "one", pageId: "one", title: "One", snippet: "", score: 3 };
  expect(mergeHits([base], [{ ...base, score: 15, snippet: "Winner" }])).toEqual([{ ...base, score: 15, snippet: "Winner" }]);
});

it("scans across key ranges without skipping the boundary and cancels obsolete queries", async () => {
  const { fake, shells } = await setup(Array.from({ length: 502 }, (_, i) => page({ id: String(i).padStart(4, "0"), blocks: [b("paragraph", { html: i === 501 ? "needle" : "other" })] })));
  expect((await searchStoredPages(shells, "needle"))[0].pageId).toBe("0501");
  expect(fake.stats.reads.search).toBe(2); expect(fake.stats.reads.bodies ?? 0).toBe(0);
  fake.resetStats(); let checks = 0;
  expect(await searchStoredPages(shells, "other", 12, () => ++checks < 4)).toEqual([]);
  expect(fake.stats.reads.search).toBe(1);
  checks = 0;
  expect(await searchStoredPages(shells, "other", 12, () => { if (++checks === 4) stopLocalPersistence(); return true; })).toEqual([]);
});

it("returns no stored results without a disk and lets the existing memory search answer", async () => {
  stopLocalPersistence(); const p = page({ id: "memory", blocks: [b("paragraph", { html: "needle" })] });
  expect(await searchStoredPages({ memory: p }, "needle")).toEqual([]);
  expect(rankLocal({ memory: p }, {}, "needle")[0].pageId).toBe("memory");
});
