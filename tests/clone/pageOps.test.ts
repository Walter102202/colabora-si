import { expect, it } from "vitest";
import { applyOps, applyWorkspaceOps, diffPageToOps, invertOps, type PageOp } from "@/lib/pageOps";
import { b, column, db, page, prop, row, T, view } from "./fixtures";
import type { BlockAttr, Page, PageComment, PageVersion } from "@/lib/types";
import stale from "./fixtures/pageOps/stale-update.json";
import deletedAnchor from "./fixtures/pageOps/deleted-anchor.json";

const actor: BlockAttr = { by: "human", id: "person", at: T };
const content = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => ["rev", "attr", "createdBy", "lastEditedBy"].includes(key) ? undefined : value));
it("PO-1 diff and apply reproduce page content across collections", () => {
  const first = b(), removed = b(), moved = b(), nested = b("columns", { columns: [column([b()])] });
  const property = prop({ id: "value" }), removedProperty = prop(), r = row({ value: 1 }), deletedRow = row();
  const oldView = view(), removedView = view();
  const comment: PageComment = { id: "comment", body: "Hi", authorId: "person", authorType: "human", createdAt: T };
  const before = page({ blocks: [first, removed, moved, nested], database: { ...db([property, removedProperty], [r, deletedRow]), views: [oldView, removedView] }, comments: [comment] });
  const added = b();
  const after: Page = { ...before, title: "Updated", blocks: [moved, { ...first, html: "Edited" }, added, { ...nested, columns: [{ ...nested.columns![0], blocks: [{ ...nested.columns![0].blocks[0], html: "Nested edit" }] }] }],
    database: { ...before.database!, properties: [{ ...property, name: "Value" }, prop()], rows: [{ ...r, cells: { value: 2 } }, row({ value: 3 })], views: [{ ...oldView, name: "Updated" }, view()] },
    comments: [{ ...comment, resolved: true }, { ...comment, id: "new", body: "Another" }],
  };
  const ops = diffPageToOps(before, after);
  expect(ops).toContainEqual(expect.objectContaining({ op: "update_block", id: nested.columns![0].blocks[0].id }));
  expect(content(applyOps(before, ops, actor).page)).toEqual(content(after));
});
it("PO-2 inverse operations restore content", () => {
  const before = page({ blocks: [b("paragraph", { id: "a", html: "A" }), b("paragraph", { id: "b", html: "B" })] });
  const ops: PageOp[] = [{ op: "update_block", id: "a", patch: { html: "Changed" } }, { op: "move_block", id: "b", after: null }, { op: "insert_block", after: "a", block: b("paragraph", { id: "c" }) }, { op: "set_page", patch: { title: "Changed" } }];
  const changed = applyOps(before, ops, actor);
  expect(content(applyOps(changed.page, invertOps(before, ops), actor).page)).toEqual(content(before));
});
it("PO-3 stale revisions report theirs and apply the write", () => {
  const result = applyOps(stale.page as Page, stale.ops as PageOp[], stale.actor as BlockAttr);
  expect(result.page).toEqual(stale.expected.page);
  expect(result.results).toEqual(stale.expected.results);
});
it("PO-4 deleted anchor falls back to the live predecessor", () => {
  const result = applyOps(deletedAnchor.page as Page, deletedAnchor.ops as PageOp[], deletedAnchor.actor as BlockAttr);
  expect(result.page).toEqual(deletedAnchor.expected.page);
  expect(result.results).toEqual(deletedAnchor.expected.results);
});
it("PO-5 300 insertions are chained in order after 600 blocks", () => {
  const before = page({ blocks: Array.from({ length: 600 }, (_, i) => b("paragraph", { id: `old${i}` })) });
  const added = Array.from({ length: 300 }, (_, i) => b("paragraph", { id: `new${i}` }));
  const after = { ...before, blocks: [...before.blocks, ...added] }, ops = diffPageToOps(before, after);
  expect(ops).toHaveLength(300);
  ops.forEach((op, i) => expect(op).toEqual({ op: "insert_block", after: i ? `new${i - 1}` : "old599", block: added[i] }));
});
it("PO-6 versions are capped at 50", () => {
  const before = page();
  const versions: PageVersion[] = Array.from({ length: 51 }, (_, i) => ({ id: `v${i}`, createdAt: T + i, title: `Version ${i}`, blocks: [] }));
  const result = applyOps(before, versions.map((version) => ({ op: "version_add", version })), actor);
  expect(result.page.versions).toEqual(versions.slice(1).reverse());
});
it("PO-7 workspace synced blocks are replaced and removed immutably", () => {
  const workspace = { pages: {}, rootOrder: [], expanded: {}, syncedBlocks: { a: [b()] } };
  const blocks = [b()];
  const next = applyWorkspaceOps(workspace, [{ op: "synced_set", key: "a", blocks: null }, { op: "synced_set", key: "b", blocks }]);
  expect(next.syncedBlocks).toEqual({ b: blocks }); expect(workspace.syncedBlocks).toHaveProperty("a");
});

it("linked views round trip through block operations and their inverse", () => {
  const linked = b("database", { pageId: "source", linkedViews: [view({ id: "local-view" })] }), before = page({ blocks: [linked] });
  const after = { ...before, blocks: [{ ...linked, linkedViews: [view({ id: "local-view", name: "Focused", filters: [{ id: "filter", propertyId: "title", operator: "contains", value: "A" }] })] }] };
  const ops = diffPageToOps(before, after), applied = applyOps(before, ops, actor);
  expect(ops).toHaveLength(1); expect(ops[0].op).toBe("update_block");
  expect(content(applied.page)).toEqual(content(after));
  expect(content(applyOps(applied.page, applied.inverse, actor).page)).toEqual(content(before));
});
