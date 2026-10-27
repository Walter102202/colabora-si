"use client";
import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { caretOffset, focusAtEnd, focusAtStart, setCaretAtOffset } from "@/lib/caret";

import { sanitizeHtml } from "@/lib/utils";

export interface EditableHandle {
  el: HTMLDivElement | null;
  focus: (toEnd?: boolean) => void;
  getHtml: () => string;
  getText: () => string;
  setHtml: (html: string) => void;
}
interface EditableProps {
  html: string;
  placeholder?: string;
  className?: string;
  onInput?: (html: string) => void;
  onBlurSave?: (html: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onClickCapture?: (event: React.MouseEvent) => void;
  spellCheck?: boolean;
  readOnly?: boolean;
}
function insertSafeHtml(element: HTMLDivElement, html: string): void {
  const safe = sanitizeHtml(html);
  if (!safe) return;
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = selection.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer)
    ? selection.getRangeAt(0) : document.createRange();
  if (!element.contains(range.commonAncestorContainer)) { range.selectNodeContents(element); range.collapse(false); }
  const fragment = range.createContextualFragment(safe), last = fragment.lastChild;
  range.deleteContents(); range.insertNode(fragment);
  if (last) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
const markEmpty = (element: HTMLDivElement) => element.classList.toggle("is-empty", !element.textContent?.trim() && !element.querySelector("img,br[data-keep]"));
const Editable = forwardRef<EditableHandle, EditableProps>(function Editable(props, ref) {
  const element = useRef<HTMLDivElement>(null);
  const safeHtml = useMemo(() => sanitizeHtml(props.html), [props.html]);
  const renderedHtml = useRef(safeHtml);
  useLayoutEffect(() => {
    const node = element.current;
    if (node && node.innerHTML !== safeHtml && (document.activeElement !== node || safeHtml !== renderedHtml.current)) {
      const focused = document.activeElement === node, offset = focused ? caretOffset(node) : 0;
      node.innerHTML = safeHtml;
      if (focused) setCaretAtOffset(node, offset);
    }
    renderedHtml.current = safeHtml;
    if (node) markEmpty(node);
  });
  useImperativeHandle(ref, () => ({
    get el() { return element.current; },
    focus: (toEnd = true) => { if (element.current) (toEnd ? focusAtEnd : focusAtStart)(element.current); },
    getHtml: () => element.current?.innerHTML ?? "",
    getText: () => element.current?.textContent ?? "",
    setHtml: (html) => { if (element.current) { element.current.innerHTML = sanitizeHtml(html); markEmpty(element.current); } },
  }), []);
  return <div ref={element} contentEditable={!props.readOnly} suppressContentEditableWarning role="textbox" aria-multiline="true" data-placeholder={props.readOnly ? "" : props.placeholder} spellCheck={props.spellCheck ?? true} className={`outline-none ${props.className ?? ""}`}
    onInput={(event) => { markEmpty(event.currentTarget); props.onInput?.(event.currentTarget.innerHTML); }} onBlur={(event) => props.onBlurSave?.(event.currentTarget.innerHTML)} onKeyDown={props.onKeyDown} onPaste={(event) => {
      if (props.readOnly) { event.preventDefault(); return; }
      props.onPaste?.(event);
      if (event.defaultPrevented) return;
      const html = event.clipboardData.getData("text/html"), text = event.clipboardData.getData("text/plain");
      event.preventDefault();
      insertSafeHtml(event.currentTarget, html || escapeText(text));
    }} onDragOver={(event) => { if (!props.readOnly && event.dataTransfer.types.includes("text/html")) event.preventDefault(); }} onDrop={(event) => {
      if (!event.dataTransfer.types.includes("text/html")) return;
      event.preventDefault(); event.stopPropagation();
      if (props.readOnly) return;
      const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (range && event.currentTarget.contains(range.commonAncestorContainer)) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      insertSafeHtml(event.currentTarget, event.dataTransfer.getData("text/html"));
    }} onFocus={props.onFocus} onClickCapture={props.onClickCapture} />;
});
export default Editable;
