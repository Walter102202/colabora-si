// GET /functions/v1/pub-html/<pageId>[.md]: a public page as HTML for crawlers and link previews, or as Markdown
// for agents. The page is read through the anon client with the same RPC the web app's /pub route calls
// (get_page_bundle): the "published" rule and RLS decide, this function adds nothing on top.
import type { Db } from '../_shared/db.ts';
import type { Block, Page } from '../_shared/lib/types.ts';
import { escapeHtml, renderPublicPage } from '../_shared/pageToHtml.ts';
import { pageToMarkdown } from '../_shared/pageToMarkdown.ts';

export interface PubHtmlDeps {
  /** Client built with the anon key; never the service role. */
  db: Db;
  /** Public URL of the web app without a trailing slash; '' when unset (links then point at this function). */
  appUrl: string;
}

export type Format = 'html' | 'markdown';

export interface Route {
  /** Path of the function itself, e.g. "/functions/v1/pub-html". */
  base: string;
  id: string;
  suffix: 'md' | null;
}

const SITE = 'colabora.si';
const PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CACHE_OK = 'public, max-age=60, s-maxage=300';
const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'";
const COMMON: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'accept, authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Accept',
};

/** Splits "<prefix>/pub-html/<id>[.md]" into the function base path, the id and the suffix. Null without an id. */
export function parseRoute(pathname: string): Route | null {
  const m = /^(.*\/pub-html)\/([^/]*?)(\.md)?\/?$/.exec(pathname);
  if (!m || !m[2]) return null;
  return { base: m[1], id: m[2], suffix: m[3] ? 'md' : null };
}

/** True when the Accept header lists text/markdown with a weight at least as high as text/html. */
export function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    if (!Number.isFinite(weight)) continue;
    const name = type.trim().toLowerCase();
    if (name === 'text/markdown') markdown = Math.max(markdown, weight);
    else if (name === 'text/html') html = Math.max(html, weight);
  }
  return markdown > 0 && markdown >= html;
}

type Loaded =
  | { status: 200; page: Page; pages: Record<string, Page>; syncedBlocks: Record<string, Block[]>; updatedAt?: number }
  | { status: 404 }
  | { status: 503 };

/** Same call as the app's fetchPageBundle: only p_page_id, defaults for the rest. Null means not public. */
async function loadPublicPage(db: Db, id: string): Promise<Loaded> {
  const { data, error } = await db.rpc<Record<string, unknown>>('get_page_bundle', { p_page_id: id });
  if (error) return { status: 503 };
  const raw = data && typeof data === 'object' ? data : null;
  const page = raw?.page && typeof raw.page === 'object' ? (raw.page as Page) : null;
  if (!raw || !page || page.isDeleted) return { status: 404 };
  const root: Page = { ...page, id: page.id || id };
  const pages: Record<string, Page> = { [root.id]: root };
  for (const [key, value] of Object.entries((raw.pages ?? {}) as Record<string, unknown>)) {
    if (value && typeof value === 'object' && key !== root.id) pages[key] = value as Page;
  }
  const syncedBlocks = Object.fromEntries(
    Object.entries((raw.syncedBlocks ?? {}) as Record<string, unknown>).filter(([, v]) => Array.isArray(v)),
  ) as Record<string, Block[]>;
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : typeof root.updatedAt === 'number' ? root.updatedAt : undefined;
  return { status: 200, page: root, pages, syncedBlocks, updatedAt };
}

/** With APP_URL, pages link to the app (/pub/<id>, which crawlers get rewritten to this function); without it, to this function. */
function links(appUrl: string, functionUrl: string) {
  const base = appUrl || functionUrl;
  const path = appUrl ? '/pub/' : '/';
  return { base, path, page: (id: string) => `${base}${path}${encodeURIComponent(id)}` };
}

function respond(status: number, body: string, type: string, head: boolean, headers: Record<string, string>): Response {
  const h = new Headers({ ...COMMON, ...headers });
  h.set('Content-Type', `${type}; charset=utf-8`);
  if (head) h.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  return new Response(head ? null : body, { status, headers: h });
}

function problem(status: number, title: string, detail: string, format: Format, head: boolean, headers: Record<string, string> = {}): Response {
  const body = format === 'markdown'
    ? `# ${title}\n\n${detail}\n`
    : `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} · ${SITE}</title></head>` +
      `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>\n`;
  return respond(status, body, format === 'markdown' ? 'text/markdown' : 'text/html', head, { 'Cache-Control': 'no-store', ...headers });
}

export async function handlePubHtml(req: Request, deps: PubHtmlDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: COMMON });
  const head = req.method === 'HEAD';
  const url = new URL(req.url);
  const route = parseRoute(url.pathname);
  const format: Format = route?.suffix === 'md' || wantsMarkdown(req.headers.get('accept')) ? 'markdown' : 'html';
  if (req.method !== 'GET' && !head) {
    return problem(405, 'Method not allowed', 'Use GET or HEAD.', format, false, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (!route || !PAGE_ID.test(route.id)) return problem(400, 'Invalid page id', 'The page id in the URL is not valid.', format, head);

  const loaded = await loadPublicPage(deps.db, route.id);
  if (loaded.status === 404) return problem(404, 'Not found', "This page doesn't exist or is no longer public.", format, head);
  if (loaded.status === 503) {
    return problem(503, 'Temporarily unavailable', 'The page could not be read. Try again in a moment.', format, head, { 'Retry-After': '30' });
  }

  const { page, pages, syncedBlocks, updatedAt } = loaded;
  const link = links(deps.appUrl, `${url.origin}${route.base}`);
  const canonicalUrl = link.page(route.id);
  const markdownUrl = `${canonicalUrl}.md`;
  if (format === 'markdown') {
    const md = pageToMarkdown(page, {
      pages,
      syncedBlocks,
      linkBase: link.base,
      pagePath: link.path,
      maxBlocks: Math.max(1, page.blocks?.length ?? 0),
      maxChars: Infinity,
    });
    return respond(200, `${md.markdown}\n`, 'text/markdown', head, {
      'Cache-Control': CACHE_OK,
      Link: `<${canonicalUrl}>; rel="alternate"; type="text/html"`,
    });
  }
  const html = renderPublicPage(page, { pages, syncedBlocks, pageUrl: link.page, canonicalUrl, markdownUrl, updatedAt, siteName: SITE });
  return respond(200, html, 'text/html', head, {
    'Cache-Control': CACHE_OK,
    'Content-Security-Policy': CSP,
    Link: `<${markdownUrl}>; rel="alternate"; type="text/markdown"`,
  });
}
