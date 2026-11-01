// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { applyType, indentBlock, mergeWithPrevious, movePageBlocks, numbering, outdentBlock, splitBlock, visibleBlocks } from "@/lib/blockOps";
import { b, column } from "./fixtures";
it("BO-1 split preserves HTML fragments and continues lists", () => {
  const source = b("todo", { html: "<b>hello</b>", checked: true, indent: 1 });
  const next = splitBlock([source], source.id, { before: "<b>he</b>", after: "<b>llo</b>" });
  expect(next[0].html).toBe("<b>he</b>"); expect(next[1]).toMatchObject({ type: "todo", html: "<b>llo</b>", checked: false, indent: 1 });
  expect(splitBlock([b("todo", { id: "empty", html: "" })], "empty", { before: "", after: "" })[0].type).toBe("paragraph");
  const toggle = b("toggle", { id: "toggle", collapsed: true });
  const children = splitBlock([toggle], "toggle", { before: "text", after: "child" });
  expect(children[0].collapsed).toBe(false); expect(children[1].indent).toBe(1);
});
it("BO-2 merge joins text or removes non-text predecessor", () => {
  const first = b("paragraph", { html: "<b>a</b>" }), second = b("paragraph", { html: "b", indent: 2 });
  expect(mergeWithPrevious([first, second], second.id)).toEqual([{ ...first, html: "<b>a</b>b" }]);
  expect(mergeWithPrevious([b("divider"), second], second.id)).toEqual([second]);
});
it("BO-3 indent is bounded by predecessor", () => {
  const first = b(), second = b(); expect(indentBlock([first], first.id)).toEqual([first]);
  const indented = indentBlock([first, second], second.id); expect(indented[1].indent).toBe(1);
  expect(indentBlock(indented, second.id)).toBe(indented);
});
it("BO-4 outdent stops at zero", () => {
  const block = b("paragraph", { indent: 1 }); const next = outdentBlock([block], block.id); expect(next[0].indent).toBe(0); expect(outdentBlock(next, block.id)).toBe(next);
});
it("BO-5 converting code uses visible text and escapes literal code", () => {
  const block = b("paragraph", { html: "<b>x</b> &amp; y" }); expect(applyType([block], block.id, "code")[0].html).toBe("x & y");
  const code = b("code", { html: "<b>x</b>" }); expect(applyType([code], code.id, "paragraph")[0].html).toBe("&lt;b&gt;x&lt;/b&gt;");
});
it("BO-6 numbering respects nesting and same-level separators", () => {
  const blocks = [b("numbered"), b("paragraph", { indent: 1 }), b("numbered"), b("paragraph"), b("numbered")];
  expect(numbering(blocks)).toEqual({ [blocks[0].id]: 1, [blocks[2].id]: 2, [blocks[4].id]: 1 });
});
it("BO-7 collapsed toggles and headings hide their descendants", () => {
  const blocks = [b("toggle", { collapsed: true }), b("paragraph", { indent: 1 }), b("heading1", { toggleable: true, collapsed: true }), b("paragraph"), b("heading2"), b("heading1")];
  expect(visibleBlocks(blocks)).toEqual([blocks[0], blocks[2], blocks[5]]);
});

it("moves a page link between columns and back to the root without changing identity", () => {
  const link = b("page", { pageId: "child" }), left = column([link]), right = column([]);
  const source = [b("columns", { columns: [left, right] })];
  const moved = movePageBlocks(source, [link.id], { columnId: right.id, position: "below" });
  expect(moved[0].columns?.[0].blocks).toEqual([]);
  expect(moved[0].columns?.[1].blocks).toEqual([link]);
  expect(source[0].columns?.[0].blocks).toEqual([link]);
  const root = movePageBlocks(moved, [link.id], { columnId: null, position: "below" });
  expect(root[1]).toBe(link);
  expect(root[0].columns?.[1].blocks).toEqual([]);
});

it("moves a multi-selection in document order with hidden descendants and synced references", () => {
  const toggle = b("toggle", { collapsed: true }), child = b("synced", { indent: 1, syncedFrom: "shared" }), second = b(), end = b();
  const source = [toggle, child, second, end];
  const next = movePageBlocks(source, [second.id, toggle.id], { columnId: null, id: end.id, position: "below" });
  expect(next).toEqual([end, toggle, child, second]);
  expect(next[2]).toBe(child);
});

it("moves indented subtrees relative to the destination and inserts after its children", () => {
  const parent = b("toggle"), child = b("paragraph", { indent: 1 }), moved = b("toggle", { indent: 2 }), descendant = b("paragraph", { indent: 3 });
  const left = column([moved, descendant]);
  const next = movePageBlocks([parent, child, b("columns", { columns: [left] })], [moved.id], { columnId: null, id: parent.id, position: "below" });
  expect(next.slice(0, 4)).toEqual([parent, child, { ...moved, indent: 0 }, { ...descendant, indent: 1 }]);
});

it("rejects self drops, missing destinations, and moving a column group inside itself", () => {
  const child = b(), nested = column([child]), group = b("columns", { columns: [nested] }), source = [group];
  expect(movePageBlocks(source, [group.id], { columnId: nested.id, position: "below" })).toBe(source);
  expect(movePageBlocks(source, [group.id], { columnId: null, id: group.id, position: "above" })).toBe(source);
  expect(movePageBlocks(source, [child.id], { columnId: "missing", position: "below" })).toBe(source);
  expect(movePageBlocks(source, [child.id], { columnId: null, id: "missing", position: "above" })).toBe(source);
});
