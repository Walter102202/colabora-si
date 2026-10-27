// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { applyType, indentBlock, mergeWithPrevious, numbering, outdentBlock, splitBlock, visibleBlocks } from "@/lib/blockOps";
import { b } from "./fixtures";
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
