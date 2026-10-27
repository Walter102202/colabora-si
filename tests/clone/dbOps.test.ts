// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
vi.mock("@/lib/agentActions", () => ({ runAgentAction: vi.fn().mockResolvedValue(undefined) }));
import { runAgentAction } from "@/lib/agentActions";
import { buildDbOps } from "@/lib/dbOps";
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
