// Page -> Markdown for agents, without a DOM. Every top-level block ends with an anchor `<!-- block:<id> -->`
// so the model can point edits at a block. Embedded databases render as a compact Markdown table.
import { computeCell, displayValue } from './lib/dbCompute.ts';
import type { Block, Database, DbProperty, DbRow, Page } from './lib/types.ts';

/** Block types Markdown cannot represent faithfully: their ids are reported as unknown_block_ids. */
export const UNREPRESENTABLE_TYPES = new Set(['columns', 'synced', 'embed']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Plain text of a block's HTML: tags removed, <br> as newline, entities decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

const MARKS: Record<string, string> = { strong: '**', b: '**', em: '*', i: '*', code: '`', s: '~~', del: '~~', strike: '~~' };

/** Link targets an agent may follow: http(s), mailto, and in-app page paths. Anything else drops the link and keeps the text. */
export function safeMarkdownHref(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (/^\/p\/[A-Za-z0-9_-]+$/.test(value)) return value;
  if (/^mailto:[^\s<>"']+$/i.test(value)) return value;
  if (/^https?:\/\/[^\s<>"']+$/i.test(value)) return value;
  return null;
}

/** Inline HTML (the sanitizer's subset) to Markdown. */
export function htmlToMarkdown(html: string): string {
  let out = '';
  const stack: { tag: string; close: string }[] = [];
  let skipUntil: string | null = null;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const [, slash, rawTag, rawAttrs, text] = m;
    if (text !== undefined) {
      if (!skipUntil) out += decodeEntities(text);
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (skipUntil) {
      if (slash && tag === skipUntil) skipUntil = null;
      continue;
    }
    if (tag === 'br') {
      out += '  \n';
      continue;
    }
    if (!slash) {
      const a = attrs(rawAttrs);
      if (tag === 'span' && 'data-eq' in a) {
        out += `$${a['data-eq']}$`;
        skipUntil = 'span';
        continue;
      }
      if (tag === 'a') {
        const href = safeMarkdownHref(a.href);
        if (href) {
          out += '[';
          stack.push({ tag, close: `](${href})` });
        } else {
          stack.push({ tag, close: '' });
        }
      } else if (MARKS[tag]) {
        out += MARKS[tag];
        stack.push({ tag, close: MARKS[tag] });
      } else {
        stack.push({ tag, close: '' });
      }
    } else {
      const idx = stack.map((s) => s.tag).lastIndexOf(tag);
      if (idx < 0) continue;
      while (stack.length > idx) out += stack.pop()!.close;
    }
  }
  while (stack.length) out += stack.pop()!.close;
  return out;
}

export interface RenderContext {
  pages: Record<string, Page>;
  syncedBlocks: Record<string, Block[]>;
  /** Prefix of page links, e.g. "https://app.example" (empty = relative "/p/<id>"). */
  linkBase: string;
  /** Path between linkBase and the page id: "/p/" by default, "/pub/" for public pages. */
  pagePath?: string;
  maxTableRows?: number;
}

const pageLink = (ctx: RenderContext, id: string) => `${ctx.linkBase}${ctx.pagePath ?? '/p/'}${id}`;

function titleOf(ctx: RenderContext, id: string | undefined): string {
  return (id && ctx.pages[id]?.title) || 'Untitled';
}

/** Display text of one cell, through the same compute engine as the app. */
export function displayCell(row: DbRow, prop: DbProperty, db: Database, pages: Record<string, Page>): string {
  return displayValue(computeCell(row, prop, db, pages), prop, db, pages);
}

const cellText = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** A compact Markdown table of a database: up to 8 properties and `maxRows` rows. */
export function databaseToMarkdown(db: Database, pages: Record<string, Page>, maxRows = 20): string {
  const props = db.properties.slice(0, 8);
  if (!props.length) return '_(empty database)_';
  const lines = [
    `| ${props.map((p) => cellText(p.name || p.id)).join(' | ')} |`,
    `| ${props.map(() => '---').join(' | ')} |`,
  ];
  for (const row of db.rows.slice(0, maxRows)) {
    lines.push(`| ${props.map((p) => cellText(displayCell(row, p, db, pages))).join(' | ')} |`);
  }
  const more: string[] = [];
  if (db.rows.length > maxRows) more.push(`${db.rows.length - maxRows} more rows`);
  if (db.properties.length > props.length) more.push(`${db.properties.length - props.length} more properties`);
  if (more.length) lines.push(`_(${more.join(', ')}; use query_database for the full data)_`);
  return lines.join('\n');
}

function tableToMarkdown(table: string[][]): string {
  if (!table.length) return '';
  const width = Math.max(...table.map((r) => r.length));
  const row = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cellText(htmlToMarkdown(cells[i] ?? ''))).join(' | ')} |`;
  return [row(table[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...table.slice(1).map(row)].join('\n');
}

const anchor = (id: string) => `<!-- block:${id} -->`;

interface Rendered {
  markdown: string;
  unknown: string[];
}

function renderList(blocks: Block[], ctx: RenderContext, depth: number): Rendered {
  const parts: string[] = [];
  const unknown: string[] = [];
  const counters: number[] = [];
  for (const b of blocks) {
    const r = renderBlock(b, ctx, depth, counters);
    parts.push(`${r.markdown} ${anchor(b.id)}`);
    unknown.push(...r.unknown);
  }
  return { markdown: parts.join('\n'), unknown };
}

/** Markdown of one block (no anchor). `counters` tracks numbered-list ordinals per indent. */
function renderBlock(b: Block, ctx: RenderContext, depth = 0, counters: number[] = []): Rendered {
  const indent = Math.max(0, b.indent ?? 0);
  const pad = '  '.repeat(indent);
  const text = htmlToMarkdown(b.html ?? '');
  if (b.type === 'numbered') {
    counters.length = indent + 1;
    counters[indent] = (counters[indent] ?? 0) + 1;
  } else {
    counters.length = Math.min(counters.length, indent);
  }
  const unknown: string[] = UNREPRESENTABLE_TYPES.has(b.type) ? [b.id] : [];
  const done = (markdown: string): Rendered => ({ markdown: markdown.replace(/<!--[\s\S]*?-->/g, ''), unknown });
  switch (b.type) {
    case 'paragraph':
      return done(`${pad}${text}`);
    case 'heading1':
      return done(`# ${text}`);
    case 'heading2':
      return done(`## ${text}`);
    case 'heading3':
      return done(`### ${text}`);
    case 'todo':
      return done(`${pad}- [${b.checked ? 'x' : ' '}] ${text}`);
    case 'bulleted':
      return done(`${pad}- ${text}`);
    case 'numbered':
      return done(`${pad}${counters[indent]}. ${text}`);
    case 'toggle':
      return done(`${pad}▸ ${text}`);
    case 'quote':
      return done(`${pad}> ${text}`);
    case 'callout':
      return done(`${pad}> ${b.icon ? `${b.icon} ` : ''}${text}`);
    case 'code':
      return done(`\`\`\`${b.language && b.language !== 'plaintext' ? b.language : ''}\n${htmlToText(b.html ?? '')}\n\`\`\``);
    case 'divider':
      return done('---');
    case 'equation':
      return done(`$$${b.equation ?? ''}$$`);
    case 'image':
      return done(`${pad}![${b.caption ?? ''}](${b.url ?? (b.fileId ? `file:${b.fileId}` : '')})`);
    case 'bookmark':
      return done(`${pad}[${b.bookmarkTitle || b.url || 'Bookmark'}](${b.url ?? ''})`);
    case 'file':
      return done(`${pad}[${b.fileName || 'File'}](${b.url ?? (b.fileId ? `file:${b.fileId}` : '')})`);
    case 'video':
    case 'audio':
      return done(`${pad}[${b.type}${b.caption ? `: ${b.caption}` : ''}](${b.url ?? (b.fileId ? `file:${b.fileId}` : '')})`);
    case 'embed':
      return done(`${pad}[embed${b.embedProvider ? ` (${b.embedProvider})` : ''}](${b.url ?? ''})`);
    case 'table':
      return done(tableToMarkdown(b.table ?? []));
    case 'page':
      return done(`${pad}[${titleOf(ctx, b.pageId)}](${pageLink(ctx, b.pageId ?? '')})`);
    case 'database': {
      const page = b.pageId ? ctx.pages[b.pageId] : undefined;
      const head = `**Database: [${titleOf(ctx, b.pageId)}](${pageLink(ctx, b.pageId ?? '')})** (id ${b.pageId ?? ''})`;
      if (!page?.database) return done(head);
      return done(`${head}\n\n${databaseToMarkdown(page.database, ctx.pages, ctx.maxTableRows ?? 20)}`);
    }
    case 'toc':
      return done('_(table of contents)_');
    case 'breadcrumb':
      return done('_(breadcrumb)_');
    case 'button':
      return done(`[button: ${b.buttonLabel ?? ''}]`);
    case 'columns': {
      if (depth > 2) return done('_(columns)_');
      const inner = (b.columns ?? []).map((c) => renderList(c.blocks ?? [], ctx, depth + 1));
      return {
        markdown: inner.map((r) => r.markdown).filter(Boolean).join('\n'),
        unknown: [b.id, ...inner.flatMap((r) => r.unknown)],
      };
    }
    case 'synced': {
      if (depth > 2) return done('_(synced block)_');
      const content = ctx.syncedBlocks[b.syncedFrom ?? b.id] ?? [];
      const inner = renderList(content, ctx, depth + 1);
      return { markdown: inner.markdown || '_(synced block)_', unknown: [b.id, ...inner.unknown] };
    }
    default:
      return done(`${pad}${text}`);
  }
}

export interface PageMarkdownBlock {
  id: string;
  rev: number | null;
  type: string;
  indent: number;
  markdown: string;
}

export interface PageMarkdown {
  title: string;
  markdown: string;
  blocks: PageMarkdownBlock[];
  next_cursor?: string;
  unknown_block_ids: string[];
  total_blocks: number;
}

export function encodeCursor(index: number): string {
  return btoa(`b:${index}`).replace(/=+$/, '');
}

/** Index encoded by encodeCursor; 0 for a missing cursor; null for a malformed one. */
export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  try {
    const m = /^b:(\d+)$/.exec(atob(cursor));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export interface PageMarkdownOptions extends RenderContext {
  cursor?: string;
  maxBlocks?: number;
  /** Soft limit of Markdown characters per page of results (at least one block is always returned). */
  maxChars?: number;
}

/** Renders a page (blocks, then its own database if it is one) in pages of blocks. */
export function pageToMarkdown(page: Page, opts: PageMarkdownOptions): PageMarkdown {
  const blocks = page.blocks ?? [];
  const start = decodeCursor(opts.cursor) ?? 0;
  const maxBlocks = opts.maxBlocks ?? 200;
  const maxChars = opts.maxChars ?? 60_000;
  const out: PageMarkdownBlock[] = [];
  const unknown: string[] = [];
  const counters: number[] = [];
  // Numbered-list ordinals continue across pages of results.
  for (const b of blocks.slice(0, start)) renderBlock(b, opts, 0, counters);
  let chars = 0;
  let i = start;
  for (; i < blocks.length && out.length < maxBlocks; i++) {
    const b = blocks[i];
    const r = renderBlock(b, opts, 0, counters);
    const markdown = `${r.markdown} ${anchor(b.id)}`;
    if (out.length > 0 && chars + markdown.length > maxChars) break;
    chars += markdown.length + 1;
    out.push({ id: b.id, rev: typeof b.rev === 'number' ? b.rev : null, type: b.type, indent: b.indent ?? 0, markdown });
    unknown.push(...r.unknown);
  }
  const parts = out.map((b) => b.markdown);
  if (start === 0) parts.unshift(`# ${page.title || 'Untitled'}`);
  const more = i < blocks.length;
  if (!more && page.database) parts.push(databaseToMarkdown(page.database, opts.pages, opts.maxTableRows ?? 50));
  const result: PageMarkdown = {
    title: page.title || 'Untitled',
    markdown: parts.join('\n\n'),
    blocks: out,
    unknown_block_ids: unknown,
    total_blocks: blocks.length,
  };
  if (more) result.next_cursor = encodeCursor(i);
  return result;
}

/** All blocks of a page with their plain text, including blocks nested in columns (for edit_page lookups). */
export function blocksWithText(page: Page): { block: Block; text: string }[] {
  const out: { block: Block; text: string }[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.type === 'columns') for (const c of b.columns ?? []) walk(c.blocks ?? []);
      else out.push({ block: b, text: htmlToText(b.html ?? '') });
    }
  };
  walk(page.blocks ?? []);
  return out;
}
