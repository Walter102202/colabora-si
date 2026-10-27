import { createBlock } from "@/lib/factories";
import { CODE_LANGUAGES } from "@/lib/blockMeta";
import type { Block, BlockType } from "@/lib/types";
import { safeHref, sanitizeHtml } from "@/lib/utils";

function guessLanguage(pre: Element): string {
  const match = /(?:language|lang)-([\w#+-]+)/i.exec((pre.querySelector("code") ?? pre).className);
  const aliases: Record<string, string> = { js: "javascript", ts: "typescript", py: "python", rb: "ruby", sh: "bash", shell: "bash", yml: "yaml" };
  const language = match ? aliases[match[1]] ?? match[1].toLowerCase() : "plaintext";
  return CODE_LANGUAGES.includes(language) ? language : "plaintext";
}
function tableToBlock(table: Element): Block {
  const rows: string[][] = [];
  let headerRow = !!table.querySelector("thead tr");
  for (const tr of table.querySelectorAll("tr")) {
    const cells = [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH").map((c) => sanitizeHtml(c.innerHTML).trim());
    if (cells.length) rows.push(cells);
  }
  if (!headerRow && rows.length) { const first = table.querySelector("tr"); headerRow = !!first && [...first.children].every((c) => c.tagName === "TH"); }
  const width = Math.max(1, ...rows.map((r) => r.length));
  return createBlock("table", { table: rows.length ? rows.map((r) => [...r, ...Array(width - r.length).fill("")]) : [["", ""]], tableHeaderRow: headerRow });
}
export function htmlToBlocks(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const output: Block[] = [];
  const serialize = (nodes: Node[]) => nodes.map((node) => { const div = doc.createElement("div"); div.appendChild(node.cloneNode(true)); return div.innerHTML; }).join("");
  const list = (element: Element, indent: number, out: Block[]) => {
    for (const child of Array.from(element.children)) {
      if (child.tagName === "UL" || child.tagName === "OL") { list(child, indent + 1, out); continue; }
      if (child.tagName !== "LI") continue;
      const nested = Array.from(child.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
      const checkbox = child.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
      const nodes = Array.from(child.childNodes).filter((node) => !nested.includes(node as Element));
      out.push(createBlock(checkbox ? "todo" : element.tagName === "OL" ? "numbered" : "bulleted", { html: sanitizeHtml(serialize(nodes)).trim(), indent, ...(checkbox ? { checked: checkbox.checked } : {}) }));
      for (const inner of nested) list(inner, indent + 1, out);
    }
  };
  const process = (parent: Node, indent: number, out: Block[]) => {
    let buffer: Node[] = [];
    const flush = () => {
      const html = sanitizeHtml(serialize(buffer)).trim();
      const plain = buffer.map((node) => node.textContent ?? "").join("").trim();
      if (plain && html) out.push(createBlock("paragraph", { html, indent }));
      buffer = [];
    };
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) { buffer.push(node); continue; }
      if (!(node instanceof Element)) continue;
      const tag = node.tagName;
      if (["STYLE", "SCRIPT", "META", "LINK", "TITLE"].includes(tag)) continue;
      if (/^H[1-6]$/.test(tag)) { flush(); out.push(createBlock(`heading${Math.min(3, +tag[1])}` as BlockType, { html: sanitizeHtml(node.innerHTML).trim(), indent })); }
      else if (tag === "UL" || tag === "OL") { flush(); list(node, indent, out); }
      else if (tag === "BLOCKQUOTE") { flush(); const inner: Block[] = []; process(node, indent, inner); out.push(...inner.map((b) => b.type === "paragraph" ? { ...b, type: "quote" as const } : b)); }
      else if (tag === "PRE") { flush(); out.push(createBlock("code", { html: (node.textContent ?? "").replace(/\n$/, ""), language: guessLanguage(node), indent })); }
      else if (tag === "HR") { flush(); out.push(createBlock("divider", { indent })); }
      else if (tag === "IMG" || tag === "FIGURE") {
        flush(); const image = tag === "IMG" ? node : node.querySelector("img");
        const raw = image?.getAttribute("src"), url = raw?.startsWith("data:image/") ? raw : safeHref(raw);
        if (url) out.push(createBlock("image", { url, caption: node.querySelector("figcaption")?.textContent?.trim() || image?.getAttribute("alt") || "", indent }));
        else if (tag === "FIGURE") process(node, indent, out);
      }
      else if (tag === "TABLE") { flush(); out.push({ ...tableToBlock(node), indent }); }
      else if (["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE"].includes(tag) || node.querySelector("p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table,hr,figure,section,article")) { flush(); process(node, indent, out); }
      else buffer.push(node);
    }
    flush();
  };
  process(doc.body, 0, output);
  return output;
}
