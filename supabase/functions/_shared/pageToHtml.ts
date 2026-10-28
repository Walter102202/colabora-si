// Page -> static HTML for link previews, crawlers and people without the app. No DOM and no scripts. Every string
// that comes from a page is escaped; inline markup is rebuilt from a short whitelist, never copied through.
import type { Block, Database, Page } from './lib/types.ts';
import { attrs, decodeEntities, displayCell, htmlToText } from './pageToMarkdown.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export interface HtmlContext {
  pages: Record<string, Page>;
  syncedBlocks: Record<string, Block[]>;
  /** Absolute URL of another page of the workspace, as a public page. */
  pageUrl: (id: string) => string;
  /** Rows shown per embedded database (50 by default). */
  maxTableRows?: number;
}

/** An absolute http(s) URL, or undefined for anything else (relative paths, data:, javascript:, file ids). */
export function httpUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!/^https?:\/\/[^\s<>"']+$/i.test(value)) return undefined;
  try {
    new URL(value);
    return value;
  } catch {
    return undefined;
  }
}

/** Link targets allowed in inline text: http(s), mailto, and "/p/<id>" page mentions as public page links. */
function linkHref(raw: string | undefined, ctx: HtmlContext): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  const page = /^\/p\/([A-Za-z0-9_-]+)$/.exec(value);
  if (page) return ctx.pageUrl(page[1]);
  if (/^mailto:[^\s<>"']+$/i.test(value)) return value;
  return httpUrl(value);
}

const INLINE: Record<string, string> = {
  strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'u', s: 's', del: 's', strike: 's',
  code: 'code', mark: 'mark', sup: 'sup', sub: 'sub',
};

/** Inline HTML of a block (the sanitizer's subset) rebuilt as escaped HTML with a short whitelist of tags. */
export function inlineHtml(html: string, ctx: HtmlContext): string {
  let out = '';
  const stack: { tag: string; close: string }[] = [];
  let skipUntil: string | null = null;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const [, slash, rawTag, rawAttrs, text] = m;
    if (text !== undefined) {
      if (!skipUntil) out += escapeHtml(decodeEntities(text));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (skipUntil) {
      if (slash && tag === skipUntil) skipUntil = null;
      continue;
    }
    if (tag === 'br') {
      if (!slash) out += '<br>';
      continue;
    }
    if (!slash) {
      const a = attrs(rawAttrs);
      if (tag === 'span' && 'data-eq' in a) {
        out += `<code class="eq">${escapeHtml(a['data-eq'])}</code>`;
        skipUntil = 'span';
        continue;
      }
      if (tag === 'a') {
        const href = linkHref(a.href, ctx);
        if (href) out += `<a href="${escapeHtml(href)}">`;
        stack.push({ tag, close: href ? '</a>' : '' });
      } else if (INLINE[tag]) {
        out += `<${INLINE[tag]}>`;
        stack.push({ tag, close: `</${INLINE[tag]}>` });
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

export interface BlockNode {
  block: Block;
  children: BlockNode[];
}

/** Nests a flat list of blocks by indent: a block owns the blocks that follow it with a greater indent. */
export function nestByIndent(blocks: Block[]): BlockNode[] {
  const roots: BlockNode[] = [];
  const stack: { indent: number; node: BlockNode }[] = [];
  for (const block of blocks) {
    const indent = Math.max(0, block.indent ?? 0);
    const node: BlockNode = { block, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

const LIST_TAG: Partial<Record<Block['type'], string>> = { bulleted: 'ul', numbered: 'ol', todo: 'ul' };
const MAX_DEPTH = 3;

function pageLabel(ctx: HtmlContext, id: string | undefined): string {
  const page = id ? ctx.pages[id] : undefined;
  return escapeHtml([page?.icon, page?.title || 'Untitled'].filter(Boolean).join(' '));
}

function renderBlocks(blocks: Block[], ctx: HtmlContext, depth: number): string {
  return renderNodes(nestByIndent(blocks), ctx, depth);
}

function renderNodes(nodes: BlockNode[], ctx: HtmlContext, depth: number): string {
  const out: string[] = [];
  for (let i = 0; i < nodes.length;) {
    const type = nodes[i].block.type;
    const listTag = LIST_TAG[type];
    if (!listTag) {
      const html = renderNode(nodes[i], ctx, depth);
      if (html) out.push(html);
      i++;
      continue;
    }
    const items: string[] = [];
    for (; i < nodes.length && nodes[i].block.type === type; i++) items.push(renderItem(nodes[i], ctx, depth));
    out.push(`<${listTag}${type === 'todo' ? ' class="todo"' : ''}>${items.join('')}</${listTag}>`);
  }
  return out.join('\n');
}

function renderItem(node: BlockNode, ctx: HtmlContext, depth: number): string {
  const b = node.block;
  const text = inlineHtml(b.html ?? '', ctx);
  const box = b.type === 'todo' ? `<input type="checkbox" disabled${b.checked ? ' checked' : ''}> ` : '';
  const children = node.children.length ? `\n${renderNodes(node.children, ctx, depth)}` : '';
  return `<li${b.type === 'todo' && b.checked ? ' class="done"' : ''}>${box}${text}${children}</li>`;
}

function mediaLink(b: Block): string {
  const kind = b.type === 'embed' ? `Embed${b.embedProvider ? ` (${b.embedProvider})` : ''}` : b.type[0].toUpperCase() + b.type.slice(1);
  const label = b.type === 'bookmark'
    ? b.bookmarkTitle || b.url || kind
    : b.type === 'file'
    ? b.fileName || kind
    : `${kind}${b.caption ? `: ${b.caption}` : ''}`;
  const url = httpUrl(b.url);
  const inner = url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
  const detail = b.type === 'bookmark' && b.bookmarkDescription ? ` <span class="muted">${escapeHtml(b.bookmarkDescription)}</span>` : '';
  return `<p class="media">${inner}${detail}</p>`;
}

function renderTable(b: Block, ctx: HtmlContext): string {
  const rows = b.table ?? [];
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (html: string, header: boolean) => (header ? `<th>${inlineHtml(html, ctx)}</th>` : `<td>${inlineHtml(html, ctx)}</td>`);
  const row = (r: string[], ri: number) =>
    `<tr>${Array.from({ length: width }, (_, ci) => cell(r[ci] ?? '', (!!b.tableHeaderRow && ri === 0) || (!!b.tableHeaderCol && ci === 0))).join('')}</tr>`;
  return `<table>${rows.map(row).join('')}</table>`;
}

/** A database as a table: up to 8 properties and `maxTableRows` rows; the title cell links to the row's page. */
export function databaseToHtml(db: Database, ctx: HtmlContext): string {
  const props = db.properties.slice(0, 8);
  if (!props.length) return '<p class="muted">Empty database</p>';
  const max = ctx.maxTableRows ?? 50;
  const head = `<thead><tr>${props.map((p) => `<th>${escapeHtml(p.name || p.id)}</th>`).join('')}</tr></thead>`;
  const body = db.rows.slice(0, max).map((row) => {
    const cells = props.map((p) => {
      const text = escapeHtml(displayCell(row, p, db, ctx.pages));
      return `<td>${p.id === 'title' && row.pageId ? `<a href="${escapeHtml(ctx.pageUrl(row.pageId))}">${text || 'Untitled'}</a>` : text}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  }).join('');
  const more: string[] = [];
  if (db.rows.length > max) more.push(`${db.rows.length - max} more rows`);
  if (db.properties.length > props.length) more.push(`${db.properties.length - props.length} more properties`);
  return `<table>${head}<tbody>${body}</tbody></table>${more.length ? `<p class="muted">${more.join(', ')}</p>` : ''}`;
}

function renderNode(node: BlockNode, ctx: HtmlContext, depth: number): string {
  const b = node.block;
  const text = inlineHtml(b.html ?? '', ctx);
  const children = node.children.length ? renderNodes(node.children, ctx, depth) : '';
  const nested = children ? `\n<div class="indent">\n${children}\n</div>` : '';
  switch (b.type) {
    case 'heading1':
      return `<h2>${text}</h2>${nested}`;
    case 'heading2':
      return `<h3>${text}</h3>${nested}`;
    case 'heading3':
      return `<h4>${text}</h4>${nested}`;
    case 'toggle':
      return `<details${b.collapsed ? '' : ' open'}><summary>${text}</summary>${children ? `\n${children}\n` : ''}</details>`;
    case 'quote':
      return `<blockquote>${text}</blockquote>${nested}`;
    case 'callout':
      return `<aside class="callout">${b.icon ? `<span class="emoji">${escapeHtml(b.icon)}</span> ` : ''}${text}</aside>${nested}`;
    case 'code': {
      const lang = b.language && b.language !== 'plaintext' ? ` class="language-${escapeHtml(b.language)}"` : '';
      return `<pre><code${lang}>${escapeHtml(htmlToText(b.html ?? ''))}</code></pre>${nested}`;
    }
    case 'divider':
      return `<hr>${nested}`;
    case 'equation':
      return `<p class="equation">${escapeHtml(b.equation ?? '')}</p>${nested}`;
    case 'image': {
      const src = httpUrl(b.url);
      const caption = escapeHtml(b.caption ?? '');
      if (!src) return `<p class="media">Image${caption ? `: ${caption}` : ''}</p>${nested}`;
      return `<figure><img src="${escapeHtml(src)}" alt="${caption}">${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>${nested}`;
    }
    case 'video':
    case 'audio':
    case 'file':
    case 'bookmark':
    case 'embed':
      return `${mediaLink(b)}${nested}`;
    case 'table':
      return `${renderTable(b, ctx)}${nested}`;
    case 'page':
      return `<p class="page-link"><a href="${escapeHtml(ctx.pageUrl(b.pageId ?? ''))}">${pageLabel(ctx, b.pageId)}</a></p>${nested}`;
    case 'database': {
      const page = b.pageId ? ctx.pages[b.pageId] : undefined;
      const head = `<h3><a href="${escapeHtml(ctx.pageUrl(b.pageId ?? ''))}">${pageLabel(ctx, b.pageId)}</a></h3>`;
      return `<section class="database">${head}${page?.database ? `\n${databaseToHtml(page.database, ctx)}` : ''}</section>${nested}`;
    }
    case 'columns': {
      if (depth >= MAX_DEPTH) return '';
      const columns = (b.columns ?? []).map((c) => `<div class="column">\n${renderBlocks(c.blocks ?? [], ctx, depth + 1)}\n</div>`);
      return `<div class="columns">${columns.join('')}</div>${nested}`;
    }
    case 'synced':
      if (depth >= MAX_DEPTH) return '';
      return `${renderBlocks(ctx.syncedBlocks[b.syncedFrom ?? b.id] ?? [], ctx, depth + 1)}${nested}`;
    case 'toc':
    case 'breadcrumb':
    case 'button':
      return children;
    default:
      return `${text ? `<p>${text}</p>` : ''}${nested}`;
  }
}

/** The page content (its blocks, then its own database when it is one) as semantic HTML. */
export function pageToHtml(page: Page, ctx: HtmlContext): string {
  const blocks = renderBlocks(page.blocks ?? [], ctx, 0);
  const database = page.database ? databaseToHtml(page.database, ctx) : '';
  return [blocks, database].filter(Boolean).join('\n');
}

const TEXT_TYPES = new Set(['paragraph', 'heading1', 'heading2', 'heading3', 'todo', 'bulleted', 'numbered', 'toggle', 'quote', 'callout']);

/** The first `max` characters of the page text, cut at a word boundary, for the description meta tags. */
export function pageDescription(page: Page, ctx: Pick<HtmlContext, 'syncedBlocks'>, max = 160): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (blocks: Block[], depth: number) => {
    for (const b of blocks) {
      if (length > max * 2) return;
      if (b.type === 'columns' && depth < MAX_DEPTH) for (const c of b.columns ?? []) walk(c.blocks ?? [], depth + 1);
      else if (b.type === 'synced' && depth < MAX_DEPTH) walk(ctx.syncedBlocks[b.syncedFrom ?? b.id] ?? [], depth + 1);
      else if (TEXT_TYPES.has(b.type)) {
        const text = htmlToText(b.html ?? '').replace(/\s+/g, ' ').trim();
        if (text) {
          parts.push(text);
          length += text.length + 1;
        }
      }
    }
  };
  walk(page.blocks ?? [], 0);
  const text = parts.join(' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface PublicPageOptions extends HtmlContext {
  /** URL of the page in the app: canonical, og:url and the footer link. */
  canonicalUrl: string;
  /** URL of the Markdown rendering of the same page. */
  markdownUrl: string;
  /** Last modification, epoch ms. */
  updatedAt?: number;
  siteName?: string;
}

const STYLE = [
  'body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#fff}',
  'main,footer{max-width:44rem;margin:0 auto;padding:1.5rem 1rem}',
  '.cover{width:100%;max-height:18rem;object-fit:cover;border-radius:.5rem}',
  '.icon{font-size:3rem;margin:1rem 0 0}',
  'h1{font-size:2.25rem;line-height:1.2;margin:.5rem 0 1.5rem}',
  'h2,h3,h4{margin:1.5em 0 .5em;line-height:1.3}',
  'p{margin:.5em 0}',
  '.indent{margin-left:1.5rem}',
  'ul.todo{list-style:none;padding-left:0}',
  'li.done{color:#6b7280;text-decoration:line-through}',
  'blockquote{margin:.75em 0;padding-left:1rem;border-left:3px solid #d0d7de;color:#57606a}',
  '.callout{padding:1rem;border-radius:.5rem;background:#f6f8fa}',
  'pre{padding:1rem;overflow:auto;border-radius:.5rem;background:#f6f8fa}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}',
  'table{border-collapse:collapse;width:100%;margin:.75em 0}',
  'th,td{border:1px solid #d0d7de;padding:.35rem .6rem;text-align:left;vertical-align:top}',
  'figure{margin:1em 0}',
  'img{max-width:100%;height:auto}',
  'figcaption,.muted{color:#6b7280;font-size:.875em}',
  '.columns{display:flex;gap:1.5rem;flex-wrap:wrap}',
  '.column{flex:1 1 14rem;min-width:0}',
  'details{margin:.5em 0}',
  'summary{cursor:pointer}',
  'footer{border-top:1px solid #d0d7de;font-size:.875em}',
].join('');

/** A complete HTML document for a public page: metadata for crawlers and link previews, then the content. */
export function renderPublicPage(page: Page, opts: PublicPageOptions): string {
  const site = opts.siteName ?? 'colabora.si';
  const title = page.title || 'Untitled';
  const description = pageDescription(page, opts) || `A page published on ${site}.`;
  const cover = httpUrl(page.cover);
  const modified = typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt) && opts.updatedAt > 0
    ? new Date(opts.updatedAt).toISOString()
    : undefined;
  const meta = (attr: 'property' | 'name', key: string, value: string) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · ${site}</title>`,
    meta('name', 'description', description),
    `<link rel="canonical" href="${escapeHtml(opts.canonicalUrl)}">`,
    `<link rel="alternate" type="text/markdown" href="${escapeHtml(opts.markdownUrl)}">`,
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', opts.canonicalUrl),
    meta('property', 'og:type', 'article'),
    meta('property', 'og:site_name', site),
    ...(cover ? [meta('property', 'og:image', cover)] : []),
    ...(modified ? [meta('property', 'article:modified_time', modified)] : []),
    meta('name', 'twitter:card', cover ? 'summary_large_image' : 'summary'),
    meta('name', 'twitter:title', title),
    meta('name', 'twitter:description', description),
    ...(cover ? [meta('name', 'twitter:image', cover)] : []),
    `<style>${STYLE}</style>`,
  ];
  const header = `<header>${page.icon ? `<p class="icon">${escapeHtml(page.icon)}</p>` : ''}<h1>${escapeHtml(title)}</h1></header>`;
  const edited = modified ? `<p class="muted">Edited ${modified.slice(0, 10)}</p>\n` : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    head.join('\n'),
    '</head>',
    '<body>',
    '<main>',
    '<article>',
    `${cover ? `<img class="cover" src="${escapeHtml(cover)}" alt="">\n` : ''}${header}`,
    pageToHtml(page, opts),
    `${edited}</article>`,
    '</main>',
    `<footer><a href="${escapeHtml(opts.canonicalUrl)}">Open in ${site}</a></footer>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
