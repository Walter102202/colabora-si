import { createBlock } from "@/lib/factories";
import type { Block, BlockType, EmbedProvider } from "@/lib/types";
import { safeHref } from "@/lib/utils";

function detectEmbedProvider(url: string): EmbedProvider | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "figma.com") return "figma";
    if (host === "maps.google.com" || (host === "google.com" && new URL(url).pathname.startsWith("/maps"))) return "maps";
    if (["twitter.com", "x.com"].includes(host)) return "tweet";
    if (host === "codepen.io") return "codepen";
    if (host === "loom.com") return "loom";
    if (host === "miro.com") return "miro";
    if (/\.pdf(?:[?#]|$)/i.test(url)) return "pdf";
  } catch { return null; }
  return null;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineMdToHtml(input: string): string {
  const codes: string[] = [];
  let s = input.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => { const href = safeHref(u.replace(/&amp;/g, "&")); return href ? `<a href="${escapeHtml(href).replace(/"/g, "&quot;")}">${t}</a>` : t; });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w])__([^_]+)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

const leadingIndent = (line: string): number => {
  const m = line.match(/^(\s*)/);
  if (!m) return 0;
  let spaces = 0;
  for (const ch of m[1]) spaces += ch === "\t" ? 2 : 1;
  return Math.floor(spaces / 2);
};

export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    const fence = trimmed.match(/^```([^\s`]*)\s*$/);
    if (fence) {
      const lang = fence[1] || "plaintext";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { body.push(lines[i]); i++; }
      i++;
      blocks.push(createBlock("code", { html: body.join("\n"), language: lang }));
      continue;
    }
    if (trimmed === "") { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { blocks.push(createBlock("divider")); i++; continue; }

    const indent = leadingIndent(line);
    let m: RegExpMatchArray | null;
    if ((m = trimmed.match(/^(#{1,6})\s+(.*)$/))) {
      const lvl = Math.min(3, m[1].length);
      blocks.push(createBlock(("heading" + lvl) as BlockType, { html: inlineMdToHtml(m[2]) }));
      i++; continue;
    }
    if ((m = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)/))) {
      blocks.push(createBlock("image", { url: safeHref(m[2]), caption: m[1] || undefined }));
      i++; continue;
    }
    if ((m = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/))) {
      blocks.push(createBlock("todo", { html: inlineMdToHtml(m[2]), checked: m[1].toLowerCase() === "x", indent }));
      i++; continue;
    }
    if ((m = trimmed.match(/^[-*+]\s+(.*)$/))) {
      blocks.push(createBlock("bulleted", { html: inlineMdToHtml(m[1]), indent }));
      i++; continue;
    }
    if ((m = trimmed.match(/^\d+\.\s+(.*)$/))) {
      blocks.push(createBlock("numbered", { html: inlineMdToHtml(m[1]), indent }));
      i++; continue;
    }
    if ((m = trimmed.match(/^>\s?(.*)$/))) {
      blocks.push(createBlock("quote", { html: inlineMdToHtml(m[1]) }));
      i++; continue;
    }
    if (/^https?:\/\/\S+$/.test(trimmed)) {
      const provider = detectEmbedProvider(trimmed);
      if (provider) {
        blocks.push(createBlock("embed", { url: trimmed, embedProvider: provider }));
        i++; continue;
      }
    }
    blocks.push(createBlock("paragraph", { html: inlineMdToHtml(trimmed), indent }));
    i++;
  }
  if (blocks.length === 0) blocks.push(createBlock("paragraph"));
  return blocks;
}

const EMOJI_LEAD = /^(\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|️)*)\s+/u;

export function markdownToPage(md: string) {
  const blocks = markdownToBlocks(md);
  let title = "Imported";
  let icon: string | null = null;
  const first = blocks[0];
  if (first && first.type === "heading1") {
    const text = first.html.replace(/<[^>]*>/g, "").trim();
    const em = text.match(EMOJI_LEAD);
    if (em) { icon = em[1]; title = text.slice(em[0].length).trim() || "Imported"; }
    else title = text || "Imported";
    blocks.shift();
  }
  if (blocks.length === 0) blocks.push(createBlock("paragraph"));
  return { title, icon, blocks };
}