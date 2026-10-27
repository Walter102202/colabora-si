import { safeHref, sanitizeHtml } from "@/lib/utils";
export type InlineFormat = "bold" | "italic" | "underline" | "strike" | "code";
export type ShortcutAction = InlineFormat | "link";
function exec(command: string, value?: string) {
  try { document.execCommand("styleWithCSS", false, "false"); document.execCommand(command, false, value); } catch {}
}
function getSelectionHtml(): string {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  const div = document.createElement("div"); div.appendChild(selection.getRangeAt(0).cloneContents()); return div.innerHTML;
}
function selectionWithinTag(tagName: string): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  let node: Node | null = selection.getRangeAt(0).commonAncestorContainer;
  while (node) { if (node instanceof HTMLElement && node.tagName === tagName) return node; node = node.parentNode; }
  return null;
}
function unwrap(element: HTMLElement): void { element.replaceWith(...Array.from(element.childNodes)); }
export function applyFormat(format: InlineFormat): void {
  switch (format) {
    case "bold": return exec("bold");
    case "italic": return exec("italic");
    case "underline": return exec("underline");
    case "strike": return exec("strikeThrough");
    case "code": {
      const existing = selectionWithinTag("CODE");
      if (existing) { unwrap(existing); return; }
      const html = getSelectionHtml(); if (html) exec("insertHTML", `<code>${sanitizeHtml(html)}</code>`);
    }
  }
}
export function isFormatActive(format: InlineFormat): boolean {
  try { return format === "code" ? !!selectionWithinTag("CODE") : document.queryCommandState(format === "strike" ? "strikeThrough" : format); } catch { return false; }
}
export function applyColor(colorClass: string | null): void {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const div = document.createElement("div"); div.innerHTML = getSelectionHtml();
  div.querySelectorAll<HTMLElement>("span[class]").forEach((span) => {
    const kept = [...span.classList].filter((c) => !c.startsWith("tc-") && !c.startsWith("bc-"));
    if (kept.length) span.className = kept.join(" "); else unwrap(span);
  });
  exec("insertHTML", sanitizeHtml(colorClass ? `<span class="${colorClass}">${div.innerHTML}</span>` : div.innerHTML));
}
export function createLink(url: string): void {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const candidate = /^[a-z][a-z\d+.-]*:|^[/#]/i.test(url) ? url : "https://" + url;
  const href = safeHref(candidate);
  if (href) exec("insertHTML", sanitizeHtml(`<a href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${getSelectionHtml()}</a>`));
}
export function shortcutFormat(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): ShortcutAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "s" ? "strike" : null;
  switch (key) { case "b": return "bold"; case "i": return "italic"; case "u": return "underline"; case "e": return "code"; case "k": return "link"; default: return null; }
}
export function runShortcut(action: ShortcutAction): void {
  if (action === "link") { if (!window.getSelection()?.isCollapsed) window.dispatchEvent(new Event("colabora-link-input")); }
  else applyFormat(action);
}
export function getSelectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}
