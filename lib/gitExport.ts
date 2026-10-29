import type { Page } from "@/lib/types";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { downloadBlob, pageToMarkdown } from "@/lib/export";
import { writeZip, type ZipInput } from "@/lib/zip";

export function slugify(title: string): string {
  return title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "") || "untitled";
}
// Ids are normally nanoid, but imported ids are kept as they come: only safe characters reach a file name.
export function exportPath(page: Page): string { return `${slugify(page.title)}-${page.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "page"}.md`; }
// One file name per page: a second page with the same slug and id prefix gets -2, -3, … so no two entries share a name.
export function exportPaths(pages: Record<string, Page>): Map<string, string> {
  const paths = new Map<string, string>(), used = new Set<string>();
  for (const page of Object.values(pages)) {
    const base = exportPath(page).slice(0, -3); let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name); paths.set(page.id, `${name}.md`);
  }
  return paths;
}
const pathOf = (page: Page, paths: Map<string, string>) => paths.get(page.id) ?? exportPath(page);
const isoOrNull = (ms: number) => { const date = new Date(ms); return Number.isNaN(date.getTime()) ? "null" : JSON.stringify(date.toISOString()); };
export function frontMatter(page: Page, pages: Record<string, Page>, paths = exportPaths(pages)): string {
  const parent = page.parentId ? pages[page.parentId] : undefined;
  const lines = ["---", `id: ${JSON.stringify(page.id)}`, `title: ${JSON.stringify(page.title)}`, `parent: ${parent ? JSON.stringify(pathOf(parent, paths)) : "null"}`, `updated_at: ${isoOrNull(page.updatedAt)}`];
  const database = parent?.database, row = database?.rows.find((row) => row.pageId === page.id);
  if (database && row) {
    const properties = database.properties.filter((property) => property.id !== "title");
    lines.push(properties.length ? "properties:" : "properties: {}");
    for (const property of properties) lines.push(`  ${JSON.stringify(property.name)}: ${JSON.stringify(displayValue(computeCell(row, property, database, pages), property, database, pages))}`);
  }
  return [...lines, "---"].join("\n");
}
export function rewriteInternalLinks(markdown: string, pages: Record<string, Page>, paths = exportPaths(pages)): string {
  return markdown.replace(/\]\(\/p\/([^#)]+)(?:#[^)]*)?\)/g, (match, id: string) => pages[id] ? `](${pathOf(pages[id], paths)})` : match);
}
export function pageToGitMarkdown(page: Page, pages: Record<string, Page>, paths = exportPaths(pages)): string {
  const children = Object.values(pages).filter((child) => child.parentId === page.id && !child.isDeleted).sort((a, b) => a.createdAt - b.createdAt);
  return frontMatter(page, pages, paths) + "\n\n" + rewriteInternalLinks(pageToMarkdown(page, pages), pages, paths) + (children.length ? "\n\n## Sub-pages\n\n" + children.map((child) => `- [${child.title || "Untitled"}](${pathOf(child, paths)})`).join("\n") : "");
}
export function buildGitExport(pages: Record<string, Page>, exclude: Set<string>, now: Date): ZipInput[] {
  const included = Object.fromEntries(Object.values(pages).filter((page) => !page.isDeleted && !exclude.has(page.id)).map((page) => [page.id, page]));
  const paths = exportPaths(included);
  const encode = (name: string, text: string): ZipInput => ({ name, data: new TextEncoder().encode(text) });
  return [
    ...Object.values(included).map((page) => encode(pathOf(page, paths), pageToGitMarkdown(page, included, paths))),
    encode("README.md", `# Workspace export\n\nOne Markdown file per page, exported from colabora.si on ${now.toISOString()}. Links between pages are relative. This export is one-way: edits here are not imported back.\n`),
    encode("memory/README.md", "# Memory\n\nAccepted lessons will be exported here later. Empty for now.\n"),
    encode("procedures/README.md", "# Procedures\n\nApproved procedures will be exported here later. Empty for now.\n"),
  ];
}
export function downloadGitExport(pages: Record<string, Page>, exclude: Set<string>): void {
  const now = new Date(); downloadBlob(writeZip(buildGitExport(pages, exclude, now), now), "workspace-markdown.zip");
}
