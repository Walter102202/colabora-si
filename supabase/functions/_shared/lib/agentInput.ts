// Agent input schemas and a DOM-free Markdown parser.
//
// An agent never sends `Block` objects or HTML. It sends `AgentBlockInput`
// (structured spans) or Markdown, which this module turns into
// `AgentBlockInput[]`. The server builds the HTML from these spans in SQL,
// escaping everything and filtering every href. Pure module: shared by tests,
// the `mcp` Edge Function and the tool documentation.

import type { BlockColor, PropertyType } from "./types.ts";

export type AgentSpan =
  | string                                       // plain text
  | { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; underline?: boolean; href?: string }
  | { mention: "page"; pageId: string }
  | { mention: "person"; userId: string }
  | { equation: string };

export type AgentBlockInput = {
  type: "paragraph" | "heading1" | "heading2" | "heading3" | "todo" | "bulleted" | "numbered"
      | "toggle" | "quote" | "callout" | "code" | "divider" | "equation" | "bookmark" | "image" | "file" | "page";
  spans?: AgentSpan[];            // inline content; for code it is literal text
  indent?: number;                // 0..6
  checked?: boolean; language?: string; icon?: string; url?: string; caption?: string;
  equation?: string; pageId?: string; color?: BlockColor;
  key?: string;                   // stable section key (e.g. "brief:goal"); letters, digits, "_", ":", ".", "-"
};
// Not allowed for agents: columns, synced, table, embed, button, database, video, audio, toc, breadcrumb.

export type AgentCellInput =
  | { text: string } | { number: number } | { checkbox: boolean } | { date: string; end?: string }
  | { select: string } | { status: string } | { multiSelect: string[] }
  | { url: string } | { email: string } | { phone: string }
  | { relation: string[] } | { person: string[] } | { files: string[] };

export const ALLOWED_BLOCK_TYPES: readonly AgentBlockInput["type"][] = [
  "paragraph", "heading1", "heading2", "heading3", "todo", "bulleted", "numbered",
  "toggle", "quote", "callout", "code", "divider", "equation", "bookmark", "image", "file", "page",
];

/** Property types whose value is computed; agents can never write them. */
export const COMPUTED_PROPERTY_TYPES: readonly PropertyType[] = [
  "formula", "rollup", "createdTime", "lastEditedTime", "createdBy", "lastEditedBy",
  "id", "agentStatus", "agentDelegate", "button", "ai",
];

export const MAX_INDENT = 6;

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** Same rule as the editor's safeHref: relative URLs pass; a scheme must be
 *  http, https, mailto or tel. Control characters and spaces are removed
 *  before detecting the scheme ("java\nscript:" is still javascript). */
export function agentSafeHref(raw: string | null | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const probe = value.replace(/[\u0000- \u007F- ]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!scheme) return value;
  return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Inline Markdown -> spans
// ---------------------------------------------------------------------------

type Marks = { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string };
type TextSpan = { text: string } & Marks;

const isWord = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch);
const ESCAPABLE = /[\\`*_~[\]()#>!$-]/;

function sameMarks(a: Marks, b: Marks): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code
    && !!a.strike === !!b.strike && a.href === b.href;
}

/** Finds the closing delimiter for an emphasis run starting at `from`. */
function findClose(s: string, delim: string, from: number): number {
  let j = from;
  while (j < s.length) {
    if (s[j] === "\\") { j += 2; continue; }
    if (s[j] === "`") {                                  // code spans are opaque
      const end = s.indexOf("`", j + 1);
      if (end > j) { j = end + 1; continue; }
    }
    if (s.startsWith(delim, j) && j > from && !/\s/.test(s[j - 1])) {
      if (delim.length === 1 && s[j + 1] === delim) { j += 2; continue; }  // "**" inside "*…*"
      if (delim.length === 2 && s[j + 2] === delim[0]) return j + 1;       // "***": inner "*" closes first
      if (delim === "_" && isWord(s[j + 1])) { j++; continue; }
      return j;
    }
    j++;
  }
  return -1;
}

function parseInline(s: string, marks: Marks, out: TextSpan[]): void {
  let buf = "";
  const flush = () => { if (buf) { out.push({ text: buf, ...marks }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ text: s.slice(i + 1, end), ...marks, code: true });
        i = end + 1; continue;
      }
    }
    if (ch === "[") {
      // the URL may hold one level of balanced parentheses: [x](https://a.test/f(1))
      const m = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
      if (m) {
        flush();
        const href = agentSafeHref(m[2]);
        parseInline(m[1], href ? { ...marks, href } : marks, out);
        i += m[0].length; continue;
      }
    }
    if ((s.startsWith("**", i) || s.startsWith("__", i)) && !/\s/.test(s[i + 2] ?? " ")) {
      const delim = s.slice(i, i + 2);
      const opensOk = delim === "**" || !isWord(s[i - 1]);
      const end = opensOk ? findClose(s, delim, i + 2) : -1;
      if (end > 0 && (delim === "**" || !isWord(s[end + 2]))) {
        flush();
        parseInline(s.slice(i + 2, end), { ...marks, bold: true }, out);
        i = end + 2; continue;
      }
    }
    if (s.startsWith("~~", i) && !/\s/.test(s[i + 2] ?? " ")) {
      const end = findClose(s, "~~", i + 2);
      if (end > 0) {
        flush();
        parseInline(s.slice(i + 2, end), { ...marks, strike: true }, out);
        i = end + 2; continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] !== ch && !/\s/.test(s[i + 1] ?? " ")) {
      const opensOk = ch === "*" || !isWord(s[i - 1]);
      const end = opensOk ? findClose(s, ch, i + 1) : -1;
      if (end > 0) {
        flush();
        parseInline(s.slice(i + 1, end), { ...marks, italic: true }, out);
        i = end + 1; continue;
      }
    }
    buf += ch; i++;
  }
  flush();
}

/** Inline Markdown (bold, italic, code, strike, links) to agent spans.
 *  Unformatted runs are plain strings; links with an unsafe scheme keep their
 *  text and lose the href. */
export function inlineMarkdownToSpans(input: string): AgentSpan[] {
  const raw: TextSpan[] = [];
  parseInline(input, {}, raw);
  const merged: TextSpan[] = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && sameMarks(last, span)) last.text += span.text;
    else merged.push({ ...span });
  }
  return merged.map((span) => {
    const { text, ...m } = span;
    const clean: TextSpan = { text };
    if (m.bold) clean.bold = true;
    if (m.italic) clean.italic = true;
    if (m.code) clean.code = true;
    if (m.strike) clean.strike = true;
    if (m.href) clean.href = m.href;
    return Object.keys(clean).length === 1 ? text : clean;
  });
}

// ---------------------------------------------------------------------------
// Block Markdown -> AgentBlockInput[]
// ---------------------------------------------------------------------------

const leadingIndent = (line: string): number => {
  const m = /^[ \t]*/.exec(line);
  let spaces = 0;
  for (const ch of m ? m[0] : "") spaces += ch === "\t" ? 2 : 1;
  return Math.min(MAX_INDENT, Math.floor(spaces / 2));
};

const EMOJI_LEAD = /^(\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|️)*)\s+(.*)$/u;

function withIndent(block: AgentBlockInput, indent: number): AgentBlockInput {
  return indent > 0 ? { ...block, indent } : block;
}

/** Markdown to agent blocks, without a DOM. Grammar: `#`..`###` headings
 *  (deeper levels become heading3), `- `/`* `/`+ ` bulleted, `1. ` numbered,
 *  `- [ ]`/`- [x]` todo, `▸ ` toggle, `> ` quote, `> 💡 text` callout,
 *  fenced code with language, `---` divider, `$$…$$` equation,
 *  `![caption](url)` image, everything else a paragraph. Two spaces (or a tab)
 *  of leading whitespace add one indent level, up to 6. */
export function markdownToAgentBlocks(md: string): AgentBlockInput[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: AgentBlockInput[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");
    const trimmed = line.trim();
    const indent = leadingIndent(line);
    let m: RegExpExecArray | null;

    if ((m = /^```([^\s`]*)\s*$/.exec(trimmed))) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { body.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", spans: [body.join("\n")], language: m[1] || "plaintext" });
      continue;
    }
    if ((m = /^\$\$(.+)\$\$$/.exec(trimmed))) {
      blocks.push({ type: "equation", equation: m[1].trim() });
      i++; continue;
    }
    if (trimmed === "$$") {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") { body.push(lines[i].trim()); i++; }
      i++;
      blocks.push({ type: "equation", equation: body.join("\n").trim() });
      continue;
    }
    if (trimmed === "") { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { blocks.push({ type: "divider" }); i++; continue; }

    if ((m = /^(#{1,6})\s+(.*)$/.exec(trimmed))) {
      const level = Math.min(3, m[1].length);
      blocks.push({ type: `heading${level}` as "heading1" | "heading2" | "heading3", spans: inlineMarkdownToSpans(m[2]) });
      i++; continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed))) {
      const url = agentSafeHref(m[2]);
      if (url) blocks.push(withIndent({ type: "image", url, ...(m[1] ? { caption: m[1] } : {}) }, indent));
      else if (m[1]) blocks.push(withIndent({ type: "paragraph", spans: [m[1]] }, indent));
      i++; continue;
    }
    if ((m = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed))) {
      blocks.push(withIndent({ type: "todo", spans: inlineMarkdownToSpans(m[2]), checked: m[1] !== " " }, indent));
      i++; continue;
    }
    if ((m = /^[-*+]\s+(.*)$/.exec(trimmed))) {
      blocks.push(withIndent({ type: "bulleted", spans: inlineMarkdownToSpans(m[1]) }, indent));
      i++; continue;
    }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(trimmed))) {
      blocks.push(withIndent({ type: "numbered", spans: inlineMarkdownToSpans(m[1]) }, indent));
      i++; continue;
    }
    if ((m = /^[▸▶]\s+(.*)$/.exec(trimmed))) {
      blocks.push(withIndent({ type: "toggle", spans: inlineMarkdownToSpans(m[1]) }, indent));
      i++; continue;
    }
    if ((m = /^>\s?(.*)$/.exec(trimmed))) {
      const callout = EMOJI_LEAD.exec(m[1]);
      if (callout) blocks.push(withIndent({ type: "callout", icon: callout[1], spans: inlineMarkdownToSpans(callout[2]) }, indent));
      else blocks.push(withIndent({ type: "quote", spans: inlineMarkdownToSpans(m[1]) }, indent));
      i++; continue;
    }
    blocks.push(withIndent({ type: "paragraph", spans: inlineMarkdownToSpans(trimmed) }, indent));
    i++;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Database cells
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v));

function invalid(): never { throw new Error("invalid_input"); }

function only(input: Record<string, unknown>, keys: string[]): void {
  for (const k of Object.keys(input)) if (!keys.includes(k)) invalid();
}

/** Validates one cell value written by an agent for a property of `type`.
 *  Throws `computed_property` for computed types and `invalid_input` when the
 *  value does not match the property type. */
export function validateAgentCell(type: PropertyType, input: unknown): AgentCellInput {
  if (COMPUTED_PROPERTY_TYPES.includes(type)) throw new Error("computed_property");
  if (!isPlainObject(input)) invalid();
  switch (type) {
    case "text": only(input, ["text"]); if (typeof input.text !== "string") invalid(); return { text: input.text };
    case "number":
      only(input, ["number"]);
      if (typeof input.number !== "number" || !Number.isFinite(input.number)) invalid();
      return { number: input.number };
    case "checkbox": only(input, ["checkbox"]); if (typeof input.checkbox !== "boolean") invalid(); return { checkbox: input.checkbox };
    case "date": {
      only(input, ["date", "end"]);
      if (!isDate(input.date)) invalid();
      if (input.end === undefined) return { date: input.date };
      if (!isDate(input.end)) invalid();
      return { date: input.date, end: input.end };
    }
    case "select": only(input, ["select"]); if (typeof input.select !== "string" || !input.select) invalid(); return { select: input.select };
    case "status": only(input, ["status"]); if (typeof input.status !== "string" || !input.status) invalid(); return { status: input.status };
    case "multiSelect": only(input, ["multiSelect"]); if (!isStringArray(input.multiSelect)) invalid(); return { multiSelect: input.multiSelect };
    case "url": {
      only(input, ["url"]);
      if (typeof input.url !== "string") invalid();
      if (input.url !== "" && !agentSafeHref(input.url)) invalid();
      return { url: input.url };
    }
    case "email": {
      only(input, ["email"]);
      if (typeof input.email !== "string" || (input.email !== "" && !/^[^\s@]+@[^\s@]+$/.test(input.email))) invalid();
      return { email: input.email };
    }
    case "phone": only(input, ["phone"]); if (typeof input.phone !== "string") invalid(); return { phone: input.phone };
    case "relation": only(input, ["relation"]); if (!isStringArray(input.relation)) invalid(); return { relation: input.relation };
    case "person": only(input, ["person"]); if (!isStringArray(input.person)) invalid(); return { person: input.person };
    case "files": only(input, ["files"]); if (!isStringArray(input.files)) invalid(); return { files: input.files };
    default: return invalid();
  }
}
