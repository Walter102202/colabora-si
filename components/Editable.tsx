"use client";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { focusAtEnd, focusAtStart } from "@/lib/caret";

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
const markEmpty = (element: HTMLDivElement) => element.classList.toggle("is-empty", !element.textContent?.trim() && !element.querySelector("img,br[data-keep]"));
const Editable = forwardRef<EditableHandle, EditableProps>(function Editable(props, ref) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (node && document.activeElement !== node) { if (node.innerHTML !== props.html) node.innerHTML = props.html; markEmpty(node); }
  });
  useImperativeHandle(ref, () => ({
    get el() { return element.current; },
    focus: (toEnd = true) => { if (element.current) (toEnd ? focusAtEnd : focusAtStart)(element.current); },
    getHtml: () => element.current?.innerHTML ?? "",
    getText: () => element.current?.textContent ?? "",
    setHtml: (html) => { if (element.current) { element.current.innerHTML = html; markEmpty(element.current); } },
  }), []);
  return <div ref={element} contentEditable={!props.readOnly} suppressContentEditableWarning role="textbox" aria-multiline="true" data-placeholder={props.readOnly ? "" : props.placeholder} spellCheck={props.spellCheck ?? true} className={`outline-none ${props.className ?? ""}`}
    onInput={(event) => { markEmpty(event.currentTarget); props.onInput?.(event.currentTarget.innerHTML); }} onBlur={(event) => props.onBlurSave?.(event.currentTarget.innerHTML)} onKeyDown={props.onKeyDown} onPaste={props.onPaste} onFocus={props.onFocus} onClickCapture={props.onClickCapture} />;
});
export default Editable;
