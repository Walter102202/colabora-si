// @vitest-environment happy-dom
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { useStore } from "@/lib/store";
import { canUndo, canRedo, initHistory, pauseHistory, resumeHistory, rebaseHistory, undo, redo } from "@/lib/history";
import { foreignPageIds } from "@/lib/foreignPages";
import { seedWorkspace } from "@/lib/seed";
import { b, column, db, page, prop, row } from "./fixtures";
import type { Page } from "@/lib/types";
import { findBacklinks, pageBlockCount, pageWordCount } from "@/lib/pageStats";

const advance = () => vi.advanceTimersByTime(400);
const change = (pages: Record<string, Page>) => { useStore.setState({ pages }); advance(); };
function reset(pages: Record<string, Page> = {}, rootOrder: string[] = []) {
  advance();
  while (canUndo()) undo();
  pauseHistory(); useStore.setState({ pages, rootOrder, syncedBlocks: {} }); resumeHistory(); advance();
}
beforeAll(() => { vi.useFakeTimers(); initHistory(); });
beforeEach(() => { foreignPageIds.clear(); reset(); });
afterAll(() => { vi.useRealTimers(); });

it("A-2-7 remote reparenting removes the old root in history", () => {
  reset({ child: page({ id: "child" }) }, ["child", "other"]);
  change({ child: page({ id: "child", title: "new" }) });
  rebaseHistory({ pages: { child: page({ id: "child", parentId: "parent" }) } });
  undo(); expect(useStore.getState().rootOrder).not.toContain("child");
});
it("A-2-8 remote deletion removes historical roots", () => {
  reset({ a: page({ id: "a" }) }, ["a", "b"]); change({});
  rebaseHistory({ pages: { a: page({ id: "a", isDeleted: true }) } });
  undo(); expect(useStore.getState().rootOrder).not.toContain("a");
});
it("A-2-9 remote root order replaces snapshots", () => {
  reset({}, ["y", "x"]); change({ a: page() });
  pauseHistory(); useStore.setState({ rootOrder: ["remote1", "remote2"] }); resumeHistory();
  rebaseHistory({ rootOrder: ["remote1", "remote2"] }); undo();
  expect(useStore.getState().rootOrder).toEqual(["remote1", "remote2"]);
});
it("A-2-10 empty rebase leaves original references", () => {
  const first = page(); reset({ a: first }); change({ a: page() });
  rebaseHistory({}); rebaseHistory({ pages: {} }); undo();
  expect(useStore.getState().pages.a).toBe(first);
});
it("A-2-11 redo is rebased too", () => {
  const remote = page(); change({ a: page() }); undo();
  rebaseHistory({ pages: { a: remote } }); redo(); expect(useStore.getState().pages.a).toBe(remote);
});
it("A-2-12 paused changes are excluded", () => {
  pauseHistory(); change({ a: page() }); resumeHistory(); expect(canUndo()).toBe(false);
});
it("A-2-13 nested pauses remain paused", () => {
  pauseHistory(); pauseHistory(); resumeHistory(); change({ a: page() }); expect(canUndo()).toBe(false);
  resumeHistory(); change({ b: page() }); expect(canUndo()).toBe(true);
});
it("A-2-14 pause depth never goes negative", () => {
  resumeHistory(); resumeHistory(); pauseHistory(); change({ a: page() }); expect(canUndo()).toBe(false); resumeHistory();
});
it("A-2-15 empty undo preserves references", () => {
  const pages = useStore.getState().pages; undo(); expect(useStore.getState().pages).toBe(pages);
});
it("A-2-16 empty redo preserves references", () => {
  change({ a: page() }); const pages = useStore.getState().pages;
  expect(canRedo()).toBe(false); redo(); expect(useStore.getState().pages).toBe(pages);
});
it("A-2-17 undo and redo traverse snapshots", () => {
  const a = page(); change({ a }); change({ a, b: page() });
  for (const [action, keys] of [[undo, ["a"]], [undo, []], [redo, ["a"]], [redo, ["a", "b"]]] as const) {
    action(); expect(Object.keys(useStore.getState().pages)).toEqual(keys);
  }
});
it("A-2-18 new changes discard redo", () => {
  change({ a: page() }); undo(); change({ b: page() }); expect(canRedo()).toBe(false);
});
it("A-2-20 persist uses version 1 and excludes foreign pages and directory caches", () => {
  foreignPageIds.add("foreign"); change({ local: page(), foreign: page() });
  const persisted = JSON.parse(localStorage.getItem("colabora-workspace")!);
  expect(persisted.version).toBe(1); expect(Object.keys(persisted.state.pages)).toEqual(["local"]);
  expect(persisted.state).not.toHaveProperty("members"); expect(persisted.state).not.toHaveProperty("agents");
});
it("ST-1 seed has four roots and the Agent Tasks contract", () => {
  const seed = seedWorkspace(); expect(seed.rootOrder).toHaveLength(4);
  const tasks = seed.pages[seed.rootOrder[3]];
  expect(tasks.title).toBe("Agent Tasks");
  expect(tasks.database!.properties.map((p) => p.name)).toEqual(["Task", "Lead", "Worker", "Status", "Waiting on", "Done when", "Depends on", "Output", "Cost", "Run"]);
  expect(tasks.database!.views.map((v) => v.name)).toEqual(["Table", "Waiting on you", "Working", "Board"]);
});

it("CM-1 comments identify their author and anchor and touch the page", () => {
  const p = page({ id: "comments" }); useStore.setState({ pages: { [p.id]: p }, syncUserId: null });
  useStore.getState().addComment(p.id, "  A note  ", "block");
  const current = useStore.getState().pages[p.id];
  expect(current.comments![0]).toMatchObject({ body: "A note", authorId: "local", authorType: "human", author: "You (this device)", blockId: "block", anchorId: "block", resolved: false });
  expect(current.updatedAt).toBeGreaterThan(p.updatedAt);
  expect(p.comments).toBeUndefined();
});
it("CM-2 resolving and reopening comments touches updatedAt", () => {
  const id = useStore.getState().createPage(); useStore.getState().addComment(id, "Note");
  const before = useStore.getState().pages[id], comment = before.comments![0]; advance();
  useStore.getState().toggleResolveComment(id, comment.id);
  expect(useStore.getState().pages[id].comments![0].resolved).toBe(true);
  expect(useStore.getState().pages[id].updatedAt).toBeGreaterThan(before.updatedAt);
  advance(); useStore.getState().toggleResolveComment(id, comment.id);
  expect(useStore.getState().pages[id].comments![0].resolved).toBe(false);
});
it("CM-3 deleting a comment touches updatedAt", () => {
  const id = useStore.getState().createPage(); useStore.getState().addComment(id, "Note");
  const before = useStore.getState().pages[id]; advance();
  useStore.getState().deleteComment(id, before.comments![0].id);
  expect(useStore.getState().pages[id].comments).toEqual([]);
  expect(useStore.getState().pages[id].updatedAt).toBeGreaterThan(before.updatedAt);
});

const para = (html = "") => b("paragraph", { html });
it("A-3-1 paragraph words", () => expect(pageWordCount([para("one two three")])).toBe(3));
it("A-3-2 words across paragraphs", () => expect(pageWordCount([para("a b"), para("c d e")])).toBe(5));
it("A-3-3 empty words", () => { for (const blocks of [[], [para()], [para("   ")], [para("\n\t ")]]) expect(pageWordCount(blocks)).toBe(0); });
it("A-3-4 whitespace words", () => { for (const [html, count] of [["a    b", 2], ["  a b  ", 2], ["a\nb\tc", 3]] as const) expect(pageWordCount([para(html)])).toBe(count); });
it("A-3-5 formatted words", () => { for (const html of ["<strong>one</strong> two", '<span class="tc-red"><b>a</b> <i>b</i></span>']) expect(pageWordCount([para(html)])).toBe(2); });
it("A-3-6 entities", () => { expect(pageWordCount([para("a &amp; b")])).toBe(3); expect(pageWordCount([para("&nbsp;")])).toBe(0); });
it("A-3-7 textual block types", () => { for (const type of ["paragraph", "heading1", "heading2", "heading3", "todo", "bulleted", "numbered", "toggle", "quote", "callout"] as const) expect(pageWordCount([b(type, { html: "one two" })])).toBe(2); });
it("A-3-8 nontext blocks", () => { for (const type of ["divider", "image", "bookmark", "toc", "database", "equation", "page"] as const) expect(pageWordCount([b(type, { html: "these words do not count" })])).toBe(0); });
it("A-3-9 code is plain text", () => { for (const [html, count] of [["const a = 1;", 4], ["if (a < b)", 4], ["   ", 0], ["", 0]] as const) expect(pageWordCount([b("code", { html })])).toBe(count); });
it("A-3-10 table words", () => { expect(pageWordCount([b("table", { table: [["one two", "three"], ["<b>four</b>", ""]] })])).toBe(4); for (const table of [[], undefined]) expect(pageWordCount([b("table", { table })])).toBe(0); });
it("A-3-11 column words", () => expect(pageWordCount([b("columns", { html: "ignored wrapper text", columns: [column([para("a b")]), column([para("c"), para("d e")])] })])).toBe(5));
it("A-3-12 nested column words", () => expect(pageWordCount([b("columns", { columns: [column([para("top"), b("columns", { columns: [column([para("deep words here")])] })])] })])).toBe(4));
it("A-3-13 empty columns", () => { for (const columns of [[], undefined]) expect(pageWordCount([b("columns", { columns })])).toBe(0); });
it("A-3-14 synced content is not traversed", () => expect(pageWordCount([b("synced", { html: "", syncedFrom: "orig" })])).toBe(0));
it("A-3-15 block count", () => { expect(pageBlockCount([])).toBe(0); expect(pageBlockCount([para("a"), para("b"), b("divider")])).toBe(3); });
it("A-3-16 table counts once", () => expect(pageBlockCount([b("table", { table: [["a", "b"], ["c", "d"]] })])).toBe(1));
it("A-3-17 columns and children count", () => expect(pageBlockCount([b("columns", { columns: [column([para("a"), para("b")]), column([para("c")])] })])).toBe(4));
it("A-3-18 nested column count", () => expect(pageBlockCount([b("columns", { columns: [column([b("columns", { columns: [column([para("x"), para("y")])] })])] })])).toBe(4));
it("A-3-19 empty column count", () => { for (const columns of [[], undefined]) expect(pageBlockCount([b("columns", { columns })])).toBe(1); });
it("A-3-20 synced block counts once", () => expect(pageBlockCount([b("synced", { syncedFrom: "orig" })])).toBe(1));
const target = page({ id: "target", title: "Target" });
const linksTo = (extra: Record<string, Page>) => findBacklinks({ target, ...extra }, "target").map((p) => p.id);
it("A-3-21 page backlink", () => expect(linksTo({ src: page({ id: "src", blocks: [b("page", { pageId: "target" })] }) })).toEqual(["src"]));
it("A-3-22 database backlink", () => expect(linksTo({ src: page({ id: "src", blocks: [b("database", { pageId: "target" })] }) })).toEqual(["src"]));
it("A-3-23 mention backlink", () => expect(linksTo({ src: page({ id: "src", blocks: [para('see <a href="/p/target" class="mention">Target</a>')] }) })).toEqual(["src"]));
it("A-3-24 mention in column", () => expect(linksTo({ src: page({ id: "src", blocks: [b("columns", { columns: [column([para('<a href="/p/target">T</a>')])] })] }) })).toEqual(["src"]));
it("A-3-25 page in column", () => expect(linksTo({ src: page({ id: "src", blocks: [b("columns", { columns: [column([b("page", { pageId: "target" })])] })] }) })).toEqual(["src"]));
it("A-3-26 relation backlink", () => expect(linksTo({ src: page({ id: "src", database: db([prop({ id: "rel", type: "relation" })], [row({ rel: ["other", "target"] })]) }) })).toEqual(["src"]));
it("A-3-27 unrelated relation", () => expect(linksTo({ src: page({ id: "src", database: db([prop({ id: "rel", type: "relation" })], [row({ rel: ["other"] })]) }) })).toEqual([]));
it("A-3-28 text cells are not backlinks", () => expect(linksTo({ src: page({ id: "src", database: db([prop({ id: "text", type: "text" })], [row({ text: "target" })]) }) })).toEqual([]));
it("A-3-29 backlinks deduplicate a page", () => expect(linksTo({ src: page({ id: "src", blocks: [b("page", { pageId: "target" }), para('<a href="/p/target">T</a>'), para('<a href="/p/target">T</a>')] }) })).toEqual(["src"]));
it("A-3-30 multiple backlink pages", () => expect(linksTo({ a: page({ id: "a", blocks: [b("page", { pageId: "target" })] }), c: page({ id: "c", blocks: [para('<a href="/p/target">T</a>')] }) })).toEqual(["a", "c"]));
it("A-3-31 deleted backlinks excluded", () => expect(linksTo({ src: page({ id: "src", isDeleted: true, blocks: [b("page", { pageId: "target" })] }) })).toEqual([]));
it("A-3-32 self backlink excluded", () => expect(findBacklinks({ target: { ...target, blocks: [para('<a href="/p/target">T</a>')] } }, "target")).toEqual([]));
it("A-3-33 backlink preserves reference", () => { const src = page({ id: "src", title: "Source", blocks: [b("page", { pageId: "target" })] }); expect(findBacklinks({ target, src }, "target")[0]).toBe(src); });
it("A-3-34 absent backlinks", () => { expect(findBacklinks({}, "target")).toEqual([]); expect(linksTo({ src: page({ id: "src" }) })).toEqual([]); });
it("A-3-35 other page link", () => expect(linksTo({ src: page({ id: "src", blocks: [b("page", { pageId: "elsewhere" })] }) })).toEqual([]));
