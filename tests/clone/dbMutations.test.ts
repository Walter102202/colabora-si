import { expect, it } from "vitest";
import * as mutations from "@/lib/dbMutations";
import { db, page, prop, row, T, view } from "./fixtures";

it("DM-1 deleting a row returns its page id and lifts children", () => {
  const parent = row({}, "row-page"), child = { ...row(), parentRowId: parent.id };
  const source = page({ database: db([], [parent, child]) });
  const result = mutations.deleteRow(source, parent.id, T + 1);
  expect(result.rowPageId).toBe("row-page");
  expect(result.page.database!.rows).toEqual([{ ...child, parentRowId: undefined }]);
  expect(source.database!.rows).toHaveLength(2);
});
it("DM-2 addRow on a plain page creates nothing", () => {
  let calls = 0;
  expect(mutations.addRow(page(), {}, () => `${++calls}`, T + 1)).toBeNull();
  expect(calls).toBe(0);
});
it("DM-3 title cells return a row page patch", () => {
  const theRow = row();
  expect(mutations.updateCell(page({ database: db([], [theRow]) }), theRow.id, "title", "Hello", T + 1).rowPagePatch).toEqual({ title: "Hello" });
});
it("DM-4 every successful database mutation touches updatedAt", () => {
  const property = prop(), theRow = row(), secondView = view();
  const database = db([property], [theRow]);
  database.views.push(secondView);
  database.rowTemplates = [{ id: "template", name: "Template", cells: {}, blocks: [] }];
  const source = page({ database }), now = T + 1;
  const results = [
    mutations.addRow(source, {}, undefined, now)!.page,
    mutations.updateCell(source, theRow.id, property.id, "x", now).page,
    mutations.deleteRow(source, theRow.id, now).page,
    mutations.addProperty(source, {}, now), mutations.updateProperty(source, property.id, { name: "New" }, now),
    mutations.deleteProperty(source, property.id, now), mutations.addView(source, {}, now),
    mutations.updateView(source, secondView.id, { name: "New" }, now), mutations.deleteView(source, secondView.id, now),
    mutations.setDbLocked(source, true, now), mutations.addRowFromTemplate(source, "template", undefined, now)!.page,
    mutations.saveRowAsTemplate(source, theRow.id, "Saved", undefined, now), mutations.deleteRowTemplate(source, "template", now),
  ];
  for (const result of results) { expect(result.updatedAt).toBe(now); expect(result).not.toBe(source); }
  expect(source.updatedAt).toBe(T);
});
