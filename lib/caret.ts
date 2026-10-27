export function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length === 0;
}

export function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return false;
  const post = range.cloneRange();
  post.selectNodeContents(el);
  post.setStart(range.endContainer, range.endOffset);
  return post.toString().length === 0;
}

/** Divide el contenido en el caret; devuelve el HTML anterior y posterior.
 *  Con una selección no colapsada, lo seleccionado se descarta.
 *  Sin selección: todo es `before`. */
export function splitAtCaret(el: HTMLElement): { before: string; after: string } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { before: el.innerHTML, after: "" };
  const range = sel.getRangeAt(0);
  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(el);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(el);
  afterRange.setStart(range.endContainer, range.endOffset);
  const beforeDiv = document.createElement("div");
  beforeDiv.appendChild(beforeRange.cloneContents());
  const afterDiv = document.createElement("div");
  afterDiv.appendChild(afterRange.cloneContents());
  return { before: beforeDiv.innerHTML, after: afterDiv.innerHTML };
}

/** Longitud en texto plano del contenido anterior al caret (0 sin selección). */
export function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** Coloca el caret en un offset de texto plano; si excede, al final. */
export function setCaretAtOffset(el: HTMLElement, offset: number) {
  const range = document.createRange();
  const sel = window.getSelection();
  let remaining = offset;
  let done = false;
  const walk = (node: Node) => {
    if (done) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) { range.setStart(node, remaining); range.collapse(true); done = true; return; }
      remaining -= len;
    } else {
      for (const child of Array.from(node.childNodes)) walk(child);
    }
  };
  walk(el);
  if (!done) { range.selectNodeContents(el); range.collapse(false); }
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function focusAtStart(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function focusAtEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Texto plano inmediatamente anterior al caret ("" sin selección). */
export function textBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString();
}
// Sustituye «disparador + consulta» (queryLen caracteres tras el disparador de 1 carácter)
// por `node`, añade un espacio y deja el caret tras el espacio.
export function insertMentionNode(el: HTMLElement, queryLen: number, node: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { el.appendChild(node); return; }
  const range = sel.getRangeAt(0);
  const container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) { el.appendChild(node); return; }
  const offset = range.startOffset;
  const r = document.createRange();
  r.setStart(container, Math.max(0, offset - queryLen - 1));
  r.setEnd(container, offset);
  r.deleteContents();
  r.insertNode(node);
  const space = document.createTextNode(" ");
  node.parentNode?.insertBefore(space, node.nextSibling);
  const after = document.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}
