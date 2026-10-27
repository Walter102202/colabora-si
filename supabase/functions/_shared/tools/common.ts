// Helpers shared by the tool modules: JSON schemas of the agent input types ($defs), argument readers,
// page loading under the caller's RLS, and output-schema builders.
import { type Db, must, ToolError } from '../db.ts';
import type { JsonSchema } from '../jsonSchema.ts';
import { ALLOWED_BLOCK_TYPES } from '../lib/agentInput.ts';
import type { Block, Page } from '../lib/types.ts';
import type { ToolAnnotations } from '../mcp.ts';

const BLOCK_COLORS = [
  'default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red',
  'bg-gray', 'bg-brown', 'bg-orange', 'bg-yellow', 'bg-green', 'bg-blue', 'bg-purple', 'bg-pink', 'bg-red',
];

/** JSON schemas of lib/agentInput.ts types, published once per tool as `$defs` and referenced with `$ref`. */
export const AGENT_DEFS: Record<string, JsonSchema> = {
  AgentSpan: {
    description: 'Inline content: plain text, formatted text, a page or person mention, or an inline equation.',
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          text: { type: 'string' },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          code: { type: 'boolean' },
          strike: { type: 'boolean' },
          underline: { type: 'boolean' },
          href: { type: 'string', description: 'http, https, mailto or tel; other schemes are dropped.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { mention: { const: 'page' }, pageId: { type: 'string' } },
        required: ['mention', 'pageId'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { mention: { const: 'person' }, userId: { type: 'string' } },
        required: ['mention', 'userId'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { equation: { type: 'string' } },
        required: ['equation'],
        additionalProperties: false,
      },
    ],
  },
  AgentBlockInput: {
    type: 'object',
    description: 'One block. Agents never send HTML; the server builds it from spans.',
    properties: {
      type: { type: 'string', enum: [...ALLOWED_BLOCK_TYPES] },
      spans: { type: 'array', items: { $ref: '#/$defs/AgentSpan' }, description: 'Inline content; literal text for code.' },
      indent: { type: 'integer', minimum: 0, maximum: 6 },
      checked: { type: 'boolean' },
      language: { type: 'string' },
      icon: { type: 'string' },
      url: { type: 'string' },
      caption: { type: 'string' },
      equation: { type: 'string' },
      pageId: { type: 'string' },
      color: { type: 'string', enum: BLOCK_COLORS },
    },
    required: ['type'],
    additionalProperties: false,
  },
  AgentCellInput: {
    description: 'A cell value; the key matches the property type. select/status/multiSelect take option names.',
    anyOf: [
      cell('text', { type: 'string' }),
      cell('number', { type: 'number' }),
      cell('checkbox', { type: 'boolean' }),
      {
        type: 'object',
        properties: { date: { type: 'string', description: 'ISO date or date-time' }, end: { type: 'string' } },
        required: ['date'],
        additionalProperties: false,
      },
      cell('select', { type: 'string' }),
      cell('status', { type: 'string' }),
      cell('multiSelect', { type: 'array', items: { type: 'string' } }),
      cell('url', { type: 'string' }),
      cell('email', { type: 'string' }),
      cell('phone', { type: 'string' }),
      cell('relation', { type: 'array', items: { type: 'string' }, description: 'Page ids' }),
      cell('person', { type: 'array', items: { type: 'string' }, description: 'User ids' }),
      cell('files', { type: 'array', items: { type: 'string' } }),
    ],
  },
};

function cell(key: string, value: JsonSchema): JsonSchema {
  return { type: 'object', properties: { [key]: value }, required: [key], additionalProperties: false };
}

/** Input schema with the agent `$defs` attached. */
export function withDefs(schema: JsonSchema): JsonSchema {
  return { ...schema, $defs: AGENT_DEFS };
}

export function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Output schemas list properties without `required`, so error results ({code, message, detail}) still conform. */
export function output(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties };
}

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
/** Writes that take an idempotency key or are idempotent by design. */
export const WRITE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
export const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export interface PageBundle {
  page: Page;
  pages: Record<string, Page>;
  syncedBlocks: Record<string, Block[]>;
  truncated: boolean;
}

export interface PageRow {
  id: string;
  revision: number | null;
  updated_at: string | null;
  last_edited_by_type: string | null;
}

/** get_page_bundle (RLS-checked inside the RPC) plus the page's row columns. Throws not_found. */
export async function loadPage(db: Db, pageId: string, maxPages = 50): Promise<{ bundle: PageBundle; row: PageRow }> {
  const raw = await must(db.rpc<Record<string, unknown>>('get_page_bundle', { p_page_id: pageId, p_max_pages: maxPages }));
  if (!raw || typeof raw !== 'object' || !raw.page) throw new ToolError('not_found', `Page ${pageId} was not found, or you have no access to it.`);
  const rows = await must(db.select<PageRow>({
    table: 'pages',
    columns: 'id,revision,updated_at,last_edited_by_type',
    filters: [{ col: 'id', op: 'eq', value: pageId }],
    limit: 1,
  }));
  const page = { ...(raw.page as Page), id: (raw.page as Page).id ?? pageId };
  const pages = { ...((raw.pages ?? {}) as Record<string, Page>), [pageId]: page };
  return {
    bundle: {
      page,
      pages,
      syncedBlocks: (raw.syncedBlocks ?? {}) as Record<string, Block[]>,
      truncated: raw.truncated === true,
    },
    row: rows?.[0] ?? { id: pageId, revision: page.revision ?? null, updated_at: null, last_edited_by_type: null },
  };
}

export function pageUrl(appUrl: string, pageId: string): string {
  return `${appUrl}/p/${pageId}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Opaque offset cursor for lists. */
export function offsetCursor(offset: number): string {
  return btoa(`o:${offset}`).replace(/=+$/, '');
}

export function readOffset(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return 0;
  try {
    const m = /^o:(\d+)$/.exec(atob(cursor));
    if (m) return Number(m[1]);
  } catch {
    // fall through
  }
  throw new ToolError('invalid_input', 'The cursor is not valid. Start again without it.');
}
