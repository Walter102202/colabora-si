import { expect, it } from "vitest";
import { duplicateDeep, restoreTree, softDeleteTree, wouldCycle } from "@/lib/pageMutations";
import { b, column, db, page, prop, row, T } from "./fixtures";

it("PM-1 soft delete cascades without mutating the source", () => {
  const pages = { a: page({ id: "a" }), b: page({ id: "b", parentId: "a" }), c: page({ id: "c", parentId: "b" }), other: page({ id: "other" }) };
  const next = softDeleteTree(pages, "a", T + 1);
  for (const id of ["a", "b", "c"]) expect(next[id]).toMatchObject({ isDeleted: true, updatedAt: T + 1 });
  expect(pages.a.isDeleted).toBe(false);
  expect(next.other).toBe(pages.other);
});
it("PM-2 restoring below a deleted parent moves to root", () => {
  const pages = { a: page({ id: "a", isDeleted: true }), b: page({ id: "b", parentId: "a", isDeleted: true }) };
  expect(restoreTree(pages, "b", T + 1).b).toMatchObject({ parentId: null, isDeleted: false, updatedAt: T + 1 });
});
it("PM-3 detects descendant cycles", () => {
  const pages = { a: page({ id: "a" }), b: page({ id: "b", parentId: "a" }) };
  expect(wouldCycle(pages, "a", "b")).toBe(true);
  expect(wouldCycle(pages, "b", "a")).toBe(false);
});
it("PM-4 duplicates row pages, nested ids and internal relations", () => {
  const relation = prop({ id: "related", type: "relation", relationDbId: "a" });
  const first = row({ related: ["r2"] }, "r1"), second = row({}, "r2");
  second.parentRowId = first.id;
  const nested = b("columns", { columns: [column([b("paragraph")])] });
  const pages = { a: page({ id: "a", database: db([relation], [first, second]) }), r1: page({ id: "r1", parentId: "a", blocks: [nested] }), r2: page({ id: "r2", parentId: "a" }) };
  let id = 0;
  const result = duplicateDeep(pages, "a", () => `copy${++id}`, T + 1);
  const copy = result.pages[result.newId!], rows = copy.database!.rows;
  expect(rows[0].cells.related).toEqual([rows[1].pageId]);
  expect(rows[1].parentRowId).toBe(rows[0].id);
  expect(copy.database!.properties[0].relationDbId).toBe(copy.id);
  const child = result.pages[rows[0].pageId];
  expect(child.parentId).toBe(copy.id);
  expect(child.blocks[0].columns![0].id).not.toBe(nested.columns![0].id);
  expect(child.blocks[0].columns![0].blocks[0].id).not.toBe(nested.columns![0].blocks[0].id);
  expect(pages.r1.parentId).toBe("a");
});
