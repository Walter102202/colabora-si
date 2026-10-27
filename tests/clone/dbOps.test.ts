// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
vi.mock("@/lib/agentActions", () => ({ runAgentAction: vi.fn().mockResolvedValue(undefined) }));
import { runAgentAction } from "@/lib/agentActions";
import { buildDbOps, buildLinkedDbOps, createLinkedViews } from "@/lib/dbOps";
import { useStore } from "@/lib/store";
it("DB-1 DbOps exposes the frozen functions and delegates agent actions with the row page", () => {
  const pageId = useStore.getState().createDatabasePage(), ops = buildDbOps(pageId);
  const functions = ["addRow", "updateCell", "deleteRow", "addProperty", "updateProperty", "deleteProperty", "addView", "updateView", "deleteView", "setLocked", "addRowFromTemplate", "saveRowAsTemplate", "deleteRowTemplate", "openRow", "runButton"] as const;
  for (const key of functions) expect(typeof ops[key]).toBe("function");
  expect(Object.values(ops).filter((value) => typeof value === "function")).toHaveLength(functions.length);
  expect(buildDbOps(pageId)).toBe(ops);
  const rowId = ops.addRow(), rowPageId = ops.database.rows.find((row) => row.id === rowId)!.pageId;
  const action = { id: "action", kind: "agentTask", mode: "new" } as const;
  ops.runButton(rowId, action);
  expect(runAgentAction).toHaveBeenCalledWith(action, { pageId: rowPageId });
});

import { createBlock, createView } from "@/lib/factories";
it("linked databases isolate view settings while sharing rows and properties", () => {
  const store = useStore.getState(), sourceId = store.createDatabasePage(), source = buildDbOps(sourceId);
  const makeLink = () => { const block = createBlock("database", { pageId: sourceId, linkedViews: createLinkedViews(source.database) }); const hostId = store.createPage(null, { blocks: [block], updatedAt: 1 }); return { hostId, block, ops: buildLinkedDbOps(sourceId, hostId, block.id) }; };
  const a = makeLink(), b = makeLink(), original = source.database, viewId = a.ops.database.views[0].id;
  expect(viewId).toHaveLength(12);
  expect(viewId).not.toBe(b.ops.database.views[0].id);
  expect(viewId).not.toBe(original.views[0].id);
  const patch = { name: "Focused", filters: [{ id: "f", propertyId: "title", operator: "contains" as const, value: "A" }], sorts: [{ propertyId: "title", direction: "desc" as const }], hiddenProps: [original.properties[1].id], groupBy: original.properties[1].id };
  a.ops.updateView(viewId, patch);
  expect(a.ops.database.views[0]).toMatchObject(patch);
  expect(source.database).toBe(original);
  expect(b.ops.database.views[0].name).toBe("Table");
  expect(useStore.getState().pages[a.hostId].updatedAt).toBeGreaterThan(1);
  const rowId = a.ops.addRow(); a.ops.updateCell(rowId, "title", "A shared row");
  expect(b.ops.database.rows).toBe(source.database.rows);
  expect(b.ops.database.rows[0].cells.title).toBe("A shared row");
  a.ops.addProperty({ name: "Shared property", type: "text" });
  expect(b.ops.database.properties.at(-1)?.name).toBe("Shared property");
  source.updateView(original.views[0].id, { name: "Source table" });
  expect(a.ops.database.views[0].name).toBe("Focused");
  expect(b.ops.database.views[0].name).toBe("Table");
  const saved = JSON.parse(localStorage.getItem("colabora-workspace")!).state;
  expect(saved.pages[a.hostId].blocks[0].linkedViews[0]).toMatchObject(patch);
});
it("linked view add/delete preserves the last view and host locking", () => {
  const store = useStore.getState(), sourceId = store.createDatabasePage(), source = buildDbOps(sourceId);
  const block = createBlock("database", { pageId: sourceId, linkedViews: createLinkedViews(source.database).slice(0, 1) });
  const hostId = store.createPage(null, { blocks: [block] }), ops = buildLinkedDbOps(sourceId, hostId, block.id), original = source.database;
  const extra = createView({ type: "gallery", name: "Gallery" }); ops.addView(extra);
  expect(ops.database.views).toHaveLength(2);
  ops.deleteView(extra.id); ops.deleteView(ops.database.views[0].id);
  expect(ops.database.views).toHaveLength(1);
  store.updatePage(hostId, { locked: true }); const before = useStore.getState().pages[hostId];
  ops.updateView(ops.database.views[0].id, { name: "Blocked" }); ops.addView(extra);
  expect(ops.readOnly).toBe(true); expect(useStore.getState().pages[hostId]).toBe(before);
  expect(source.database).toBe(original);
});
