// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { caretOffset, focusAtEnd, focusAtStart, isCaretAtEnd, isCaretAtStart, setCaretAtOffset, splitAtCaret, textBeforeCaret } from "@/lib/caret";
function editable(html: string) { const el = document.createElement("div"); el.contentEditable = "true"; el.tabIndex = 0; el.innerHTML = html; document.body.append(el); return el; }
function selectRange(el: HTMLElement, a: number, b: number) {
  setCaretAtOffset(el, a); const range = window.getSelection()!.getRangeAt(0).cloneRange();
  setCaretAtOffset(el, b); const end = window.getSelection()!.getRangeAt(0); range.setEnd(end.startContainer, end.startOffset);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
}
afterEach(() => { document.body.innerHTML = ""; window.getSelection()?.removeAllRanges(); });
it.each([[1, "abcdef", 6], [2, "abc<b>def</b>ghi", 9]] as const)("A-4-%i caret offset round trip", (_id, html, length) => { const el = editable(html); for (let i = 0; i <= length; i++) { setCaretAtOffset(el, i); expect(caretOffset(el)).toBe(i); } });
it("A-4-3 nested text offset", () => { const el = editable("<b>ab</b><i>cd</i><code>ef</code>"); setCaretAtOffset(el, 5); expect(caretOffset(el)).toBe(5); expect(textBeforeCaret(el)).toBe("abcde"); });
it("A-4-4 oversized offset clamps to end", () => { const el = editable("abc<b>def</b>"); setCaretAtOffset(el, 999); expect(caretOffset(el)).toBe(6); expect(isCaretAtEnd(el)).toBe(true); });
it("A-4-5 empty offset", () => { const el = editable(""); setCaretAtOffset(el, 0); expect(caretOffset(el)).toBe(0); });
it("A-4-6 offset without selection", () => expect(caretOffset(editable("abc"))).toBe(0));
it("A-4-7 start boundary", () => { const el = editable("abc"); setCaretAtOffset(el, 0); expect(isCaretAtStart(el)).toBe(true); setCaretAtOffset(el, 1); expect(isCaretAtStart(el)).toBe(false); });
it("A-4-8 end boundary", () => { const el = editable("abc"); setCaretAtOffset(el, 3); expect(isCaretAtEnd(el)).toBe(true); setCaretAtOffset(el, 2); expect(isCaretAtEnd(el)).toBe(false); });
it("A-4-9 empty boundaries", () => { const el = editable(""); setCaretAtOffset(el, 0); expect(isCaretAtStart(el)).toBe(true); expect(isCaretAtEnd(el)).toBe(true); });
it("A-4-10 marked-up boundaries", () => { const el = editable("<b>abc</b>"); setCaretAtOffset(el, 0); expect([isCaretAtStart(el), isCaretAtEnd(el)]).toEqual([true, false]); setCaretAtOffset(el, 3); expect([isCaretAtStart(el), isCaretAtEnd(el)]).toEqual([false, true]); });
it("A-4-11 foreign caret", () => { const mine = editable("mine"), other = editable("other"); setCaretAtOffset(other, 0); expect([isCaretAtStart(mine), isCaretAtEnd(mine)]).toEqual([false, false]); });
it("A-4-12 boundaries without selection", () => { const el = editable("abc"); expect([isCaretAtStart(el), isCaretAtEnd(el)]).toEqual([false, false]); });
it("A-4-13 selected range is not a caret boundary", () => { const el = editable("abc"); selectRange(el, 0, 3); expect([isCaretAtStart(el), isCaretAtEnd(el)]).toEqual([false, false]); });
it.each([
  [14, "abcdef", 3, "abc", "def"], [15, "abc", 3, "abc", ""], [15, "abc", 0, "", "abc"],
  [16, "abc<b>def</b>ghi", 3, "abc", "<b>def</b>ghi"], [17, "abc<b>def</b>ghi", 4, "abc<b>d</b>", "<b>ef</b>ghi"], [18, "", 0, "", ""],
] as const)("A-4-%i split at caret", (_id, html, offset, before, after) => { const el = editable(html); setCaretAtOffset(el, offset); expect(splitAtCaret(el)).toEqual({ before, after }); });
it("A-4-19 split discards selection", () => { const el = editable("abcdef"); selectRange(el, 2, 4); expect(splitAtCaret(el)).toEqual({ before: "ab", after: "ef" }); });
it("A-4-20 split without selection", () => expect(splitAtCaret(editable("abc<b>def</b>"))).toEqual({ before: "abc<b>def</b>", after: "" }));
it("A-4-21 text preceding caret", () => { for (const [html, offset, text] of [["hello world", 5, "hello"], ["say <b>hi</b> now", 6, "say hi"], ["abc", 0, ""], ["/head", 5, "/head"]] as const) { const el = editable(html); setCaretAtOffset(el, offset); expect(textBeforeCaret(el)).toBe(text); } window.getSelection()?.removeAllRanges(); expect(textBeforeCaret(editable("abc"))).toBe(""); });
it("A-4-22 focus start", () => { const el = editable("abc<b>def</b>"); focusAtStart(el); expect(document.activeElement).toBe(el); expect(isCaretAtStart(el)).toBe(true); expect(caretOffset(el)).toBe(0); });
it("A-4-23 focus end", () => { const el = editable("abc<b>def</b>"); focusAtEnd(el); expect(document.activeElement).toBe(el); expect(isCaretAtEnd(el)).toBe(true); expect(caretOffset(el)).toBe(6); });
it("A-4-24 focusing replaces old selection", () => { const el = editable("abcdef"); selectRange(el, 1, 4); focusAtStart(el); expect(window.getSelection()!.rangeCount).toBe(1); expect(window.getSelection()!.isCollapsed).toBe(true); });
it("A-4-25 focusing empty content", () => { const el = editable(""); focusAtStart(el); expect(isCaretAtStart(el)).toBe(true); focusAtEnd(el); expect(isCaretAtEnd(el)).toBe(true); });
