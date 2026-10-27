import type { Block, Database, DbProperty, DbRow, Page } from "@/lib/types";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { blockColorClass, safeHref, sanitizeHtml } from "@/lib/utils";
import { renderMath } from "@/lib/math";
import { EXPORT_CSS } from "@/lib/exportStyles";
import { getFile } from "@/lib/fileStore";
import { safeCover } from "@/lib/cover";

export function inlineToMarkdown(html: string): string {
  if (typeof window === "undefined") return html.replace(/<[^>]*>/g, "");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    if (element.classList.contains("inline-eq")) return `$${element.dataset.eq ?? ""}$`;
    const inner = Array.from(node.childNodes).map(walk).join("");
    switch (element.tagName) {
      case "B": case "STRONG": return `**${inner}**`;
      case "I": case "EM": return `*${inner}*`;
      case "S": case "STRIKE": return `~~${inner}~~`;
      case "CODE": return "`" + inner + "`";
      case "U": return `<u>${inner}</u>`;
      case "A": return `[${inner}](${safeHref(element.getAttribute("href")) ?? ""})`;
      case "BR": return "\n";
      default: return inner;
    }
  };
  return Array.from(doc.body.childNodes).map(walk).join("");
}
export function blocksToMarkdown(blocks: Block[], pages: Record<string, Page> = {}): string {
  const lines: string[] = [], counts = new Map<number, number>();
  for (const block of blocks) {
    const pad = "  ".repeat(Math.max(0, block.indent)), text = inlineToMarkdown(block.html);
    if (block.type !== "numbered") counts.clear();
    switch (block.type) {
      case "heading1": case "heading2": case "heading3": lines.push(`${pad}${"#".repeat(Number(block.type.at(-1)) + 1)} ${text}`); break;
      case "todo": lines.push(`${pad}- [${block.checked ? "x" : " "}] ${text}`); break;
      case "bulleted": case "toggle": lines.push(`${pad}- ${text}`); break;
      case "numbered": {
        const count = (counts.get(block.indent) ?? 0) + 1;
        counts.set(block.indent, count);
        for (const level of counts.keys()) if (level > block.indent) counts.delete(level);
        lines.push(`${pad}${count}. ${text}`); break;
      }
      case "quote": lines.push(`${pad}> ${text}`); break;
      case "callout": lines.push(`${pad}> ${block.icon ?? "💡"} ${text}`); break;
      case "code": lines.push(pad + "```" + (block.language ?? ""), block.html, pad + "```"); break;
      case "divider": lines.push(`${pad}---`); break;
      case "image": if (safeHref(block.url)) lines.push(`${pad}![${block.caption ?? ""}](${safeHref(block.url)})`); break;
      case "bookmark": if (safeHref(block.url)) lines.push(`${pad}[${block.bookmarkTitle || block.url}](${safeHref(block.url)})`); break;
      case "video": case "audio": case "file": case "embed": {
        const labels = { video: ["🎬", "Video"], audio: ["🎵", "Audio"], file: ["📎", "File"], embed: ["🌐", "Embed"] };
        if (safeHref(block.url)) lines.push(`${pad}${labels[block.type][0]} [${(block.type === "file" && block.fileName) || block.caption || labels[block.type][1]}](${safeHref(block.url)})`);
        break;
      }
      case "page": lines.push(`${pad}- 📄 ${block.pageId && pages[block.pageId] ? pages[block.pageId].title || "Untitled" : "Sub-page"}`); break;
      case "table":
        for (const [i, row] of (block.table ?? []).entries()) {
          lines.push(`${pad}| ${row.map((cell) => inlineToMarkdown(cell).replace(/\|/g, "\\|") || " ").join(" | ")} |`);
          if (i === 0) lines.push(`${pad}| ${row.map(() => "---").join(" | ")} |`);
        }
        break;
      case "equation": lines.push(`${pad}$$`, block.equation ?? "", `${pad}$$`); break;
      case "columns": lines.push(...(block.columns ?? []).map((c) => blocksToMarkdown(c.blocks, pages))); break;
      case "toc": case "breadcrumb": break;
      case "button": lines.push(`${pad}🔘 ${block.buttonLabel || "Button"}`); break;
      case "synced": lines.push(`${pad}> 🔄 Synced block`); break;
      case "database": if (block.pageId && pages[block.pageId]) lines.push(`${pad}- 🗃️ ${pages[block.pageId].title || "Database"} (inline database)`); break;
      default: lines.push(pad + text);
    }
  }
  return lines.join("\n");
}
export function pageToMarkdown(page: Page, pages: Record<string, Page> = {}): string {
  const title = `# ${page.icon ? page.icon + " " : ""}${page.title || "Untitled"}\n\n`;
  if (!page.database) return title + blocksToMarkdown(page.blocks, pages);
  const database = page.database;
  const line = (values: string[]) => `| ${values.map((v) => v.replace(/\|/g, "\\|")).join(" | ")} |`;
  return title + [line(database.properties.map((p) => p.name)), line(database.properties.map(() => "---")), ...database.rows.map((row) => line(database.properties.map((p) => displayValue(computeCell(row, p, database, pages), p, database, pages))))].join("\n");
}
export const safeName = (title: string) => (title || "Untitled").replace(/[^\w\- ]+/g, "").trim() || "Untitled";
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
export function downloadMarkdown(page: Page, pages: Record<string, Page>): void {
  downloadBlob(new Blob([pageToMarkdown(page, pages)], { type: "text/markdown;charset=utf-8" }), safeName(page.title) + ".md");
}
function csvEscape(value: string): string { return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
export function rowsToCsv(properties: DbProperty[], rows: DbRow[], database: Database, pages: Record<string, Page>): string {
  return [properties.map((p) => csvEscape(p.name)).join(","), ...rows.map((row) => properties.map((p) => csvEscape(displayValue(computeCell(row, p, database, pages), p, database, pages) || "")).join(","))].join("\r\n");
}
export function downloadCsv(title: string, properties: DbProperty[], rows: DbRow[], database: Database, pages: Record<string, Page>): void {
  downloadBlob(new Blob(["\uFEFF", rowsToCsv(properties, rows, database, pages)], { type: "text/csv;charset=utf-8" }), safeName(title) + ".csv");
}

function escapeHtml(value: unknown): string { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function databaseToHtmlTable(db: Database, pages: Record<string, Page>, props: DbProperty[] = db.properties, rows: DbRow[] = db.rows): string {
  const head = `<tr>${props.map((p) => `<th>${escapeHtml(p.name)}</th>`).join("")}</tr>`;
  const body = rows.map((r) => `<tr>${props.map((p) => `<td>${escapeHtml(displayValue(computeCell(r, p, db, pages), p, db, pages) || "")}</td>`).join("")}</tr>`).join("");
  return `<table>${head}${body}</table>`;
}
async function blocksToHtml(blocks: Block[], pages: Record<string, Page>, synced: Record<string, Block[]>, seen = new Set<string>()): Promise<string> {
  const parts: string[] = [], counts = new Map<number, number>();
  for (const block of blocks) {
    const indent = Number.isFinite(block.indent) ? Math.max(0, block.indent) : 0, ind = indent ? ` style="margin-left:${indent * 24}px"` : "";
    const color = blockColorClass(block.color), cls = color ? " " + escapeHtml(color) : "", text = sanitizeHtml(block.html ?? "");
    let src = safeHref(block.url);
    if (block.fileId) { const blob = await getFile(block.fileId).catch(() => undefined); if (blob) src = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); }); }
    const caption = block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : "";
    if (block.type !== "numbered") counts.clear();
    switch (block.type) {
      case "heading1": case "heading2": case "heading3": { const tag = "h" + (Number(block.type.at(-1)) + 1); parts.push(`<${tag} class="b${cls}"${ind}>${text}</${tag}>`); break; }
      case "todo": parts.push(`<div class="b todo${cls}"${ind}><span>${block.checked ? "☑" : "☐"}</span><span${block.checked ? ' class="done"' : ""}>${text}</span></div>`); break;
      case "bulleted": parts.push(`<ul class="one"${ind}><li class="b${cls}">${text}</li></ul>`); break;
      case "numbered": {
        const count = (counts.get(indent) ?? 0) + 1; counts.set(indent, count); for (const level of counts.keys()) if (level > indent) counts.delete(level);
        parts.push(`<ol class="one" start="${count}"${ind}><li class="b${cls}">${text}</li></ol>`); break;
      }
      case "toggle": parts.push(`<details${ind}><summary class="b${cls}">${text}</summary></details>`); break;
      case "quote": parts.push(`<blockquote class="b${cls}"${ind}>${text}</blockquote>`); break;
      case "callout": parts.push(`<div class="callout${cls}"${ind}><span>${escapeHtml(block.icon ?? "💡")}</span><div class="b">${text}</div></div>`); break;
      case "code": parts.push(`<pre class="code"${ind}><code>${escapeHtml(block.html)}</code></pre>`); break;
      case "divider": parts.push(`<hr${ind}>`); break;
      case "image": if (src) {
        const align = block.align === "center" || block.align === "right" ? ` style="text-align:${block.align}"` : ind;
        const width = block.width !== undefined && Number.isFinite(block.width) ? ` style="width:${Math.max(15, Math.min(100, block.width))}%"` : "";
        parts.push(`<figure${align}><img src="${escapeHtml(src)}" alt="${escapeHtml(block.caption ?? "")}"${width}>${caption}</figure>`);
      } break;
      case "video": if (src) parts.push(`<figure${ind}><video controls src="${escapeHtml(src)}" style="max-width:100%"></video>${caption}</figure>`); break;
      case "audio": if (src) parts.push(`<figure${ind}><audio controls src="${escapeHtml(src)}"></audio></figure>`); break;
      case "file": if (src) { const label = escapeHtml(block.fileName || block.caption || "File"); parts.push(`<div class="b"${ind}>📎 <a href="${escapeHtml(src)}" download="${label}">${label}</a></div>`); } break;
      case "embed": case "bookmark": if (src) parts.push(`<a class="bookmark"${ind} href="${escapeHtml(src)}"><span class="t">${escapeHtml(block.bookmarkTitle || block.caption || block.url)}</span><div class="u">${escapeHtml(block.url)}</div></a>`); break;
      case "table": parts.push(`<table${ind}>${(block.table ?? []).map((row, r) => `<tr>${row.map((value, c) => { const tag = (block.tableHeaderRow && r === 0) || (block.tableHeaderCol && c === 0) ? "th" : "td"; return `<${tag}>${sanitizeHtml(value)}</${tag}>`; }).join("")}</tr>`).join("")}</table>`); break;
      case "equation": parts.push(`<div class="equation"${ind}>${renderMath(block.equation ?? "")}</div>`); break;
      case "columns": parts.push(`<div class="cols">${(await Promise.all((block.columns ?? []).map(async (column) => `<div style="flex:${Number.isFinite(column.width) && column.width! > 0 ? column.width : 1}">${await blocksToHtml(column.blocks, pages, synced, new Set(seen))}</div>`))).join("")}</div>`); break;
      case "synced": { const key = block.syncedFrom ?? block.id; if (!seen.has(key)) { seen.add(key); parts.push(await blocksToHtml(synced[key] ?? [], pages, synced, seen)); seen.delete(key); } break; }
      case "page": { const child = pages[block.pageId ?? ""]; parts.push(`<div class="b"${ind}>${escapeHtml(child?.icon ?? "📄")} <u>${escapeHtml(child ? child.title || "Untitled" : "Sub-page")}</u></div>`); break; }
      case "database": { const db = pages[block.pageId ?? ""]?.database; if (db) parts.push(databaseToHtmlTable(db, pages)); break; }
      case "button": parts.push(`<div class="b"${ind}>🔘 ${escapeHtml(block.buttonLabel || "Button")}</div>`); break;
      case "toc": case "breadcrumb": break;
      default: parts.push(`<div class="b${cls}"${ind}>${text}</div>`);
    }
  }
  return parts.join("\n");
}
export async function pageToHtml(page: Page, pages: Record<string, Page>, synced: Record<string, Block[]> = {}): Promise<string> {
  const title = escapeHtml(page.title || "Untitled"), value = safeCover(page.cover);
  const position = Number.isFinite(page.coverPosition) ? Math.max(0, Math.min(100, page.coverPosition!)) : 50;
  const url = value?.replace(/'/g, "%27").replace(/\\/g, "%5C").replace(/[\r\n]/g, "");
  const cover = value ? value.startsWith("linear-gradient") ? `<div class="cover" style="background:${escapeHtml(value)}"></div>` : `<div class="cover" style="background-image:url('${escapeHtml(url)}');background-position-y:${position}%"></div>` : "";
  const body = page.database ? databaseToHtmlTable(page.database, pages) : await blocksToHtml(page.blocks, pages, synced);
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>${EXPORT_CSS}</style>\n</head>\n<body>\n${cover}\n<div class="page">\n${page.icon ? `<div class="icon">${escapeHtml(page.icon)}</div>` : ""}\n<h1 class="title">${title}</h1>\n${body}\n<div class="meta">Exported from colabora.si · ${new Date().toLocaleDateString("en-US", { timeZone: "UTC" })}</div>\n</div>\n</body>\n</html>`;
}
export async function downloadHtml(page: Page, pages: Record<string, Page>, synced: Record<string, Block[]> = {}): Promise<void> {
  downloadBlob(new Blob([await pageToHtml(page, pages, synced)], { type: "text/html;charset=utf-8" }), safeName(page.title) + ".html");
}
export function exportPagePdf(): void { setTimeout(() => window.print(), 50); }
