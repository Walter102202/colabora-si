// @vitest-environment happy-dom
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { useStore } from "@/lib/store";
import { canUndo, canRedo, initHistory, pauseHistory, resumeHistory, rebaseHistory, undo, redo } from "@/lib/history";
import { foreignPageIds } from "@/lib/foreignPages";
import { seedWorkspace } from "@/lib/seed";
import { page } from "./fixtures";
import type { Page } from "@/lib/types";

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
