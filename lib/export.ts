import type { Block, Database, DbProperty, DbRow, Page } from "@/lib/types";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { safeHref } from "@/lib/utils";

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
