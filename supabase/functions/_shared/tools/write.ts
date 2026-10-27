// Partial-write tools (§IV.9.2): append_blocks, edit_page, update_block, update_row, add_row, add_comment.
// Each validates, converts Markdown to agent blocks, and calls the RPC as the caller; the RPC builds the HTML.
import { must, ToolError } from '../db.ts';
import { type AgentBlockInput, type AgentCellInput, markdownToAgentBlocks, validateAgentCell } from '../lib/agentInput.ts';
import type { Database, DbProperty } from '../lib/types.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { blocksWithText, displayCell, UNREPRESENTABLE_TYPES } from '../pageToMarkdown.ts';
import { loadPage, num, object, output, plural, str, withDefs, WRITE, WRITE_IDEMPOTENT } from './common.ts';

const MAX_BLOCKS = 500;
const idempotencyKey = { type: 'string', minLength: 1, maxLength: 200, description: 'Retry-safe key: the same key returns the first result.' } as const;

function blocksFrom(args: Record<string, unknown>, field = 'markdown'): AgentBlockInput[] {
  const hasMd = typeof args[field] === 'string';
  const hasBlocks = Array.isArray(args.blocks);
  if (hasMd === hasBlocks) throw new ToolError('invalid_input', `Pass exactly one of ${field} or blocks.`);
  const blocks = hasMd ? markdownToAgentBlocks(args[field] as string) : (args.blocks as AgentBlockInput[]);
  if (!blocks.length) throw new ToolError('invalid_input', 'Nothing to write: the content is empty.');
  if (blocks.length > MAX_BLOCKS) throw new ToolError('invalid_input', `At most ${MAX_BLOCKS} blocks per call.`);
  return blocks;
}

const appendBlocks: ToolDef = {
  name: 'append_blocks',
  title: 'Append blocks to a page',
  description:
    'Adds content to a page from Markdown or structured blocks (exactly one). Inserts at the end, or after `after_block_id`. ' +
    'Inserting never conflicts. Never send HTML.',
  inputSchema: withDefs(object({
    page_id: { type: 'string', minLength: 1 },
    markdown: { type: 'string', minLength: 1, maxLength: 200_000 },
    blocks: { type: 'array', items: { $ref: '#/$defs/AgentBlockInput' }, minItems: 1, maxItems: MAX_BLOCKS },
    after_block_id: { type: 'string' },
    idempotency_key: idempotencyKey,
  }, ['page_id'])),
  outputSchema: output({ revision: { type: 'integer' }, block_ids: { type: 'array', items: { type: 'string' } } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const blocks = blocksFrom(args);
    const data = await must(ctx.db.rpc<{ revision: number; block_ids: string[] }>('append_page_blocks', {
      p_page_id: args.page_id,
      p_blocks: blocks,
      p_after_block_id: str(args.after_block_id),
      p_idempotency_key: str(args.idempotency_key),
    }));
    const result = { revision: data?.revision ?? null, block_ids: data?.block_ids ?? [] };
    return {
      text: `Appended ${plural(result.block_ids.length, 'block')} to page ${String(args.page_id)} (revision ${result.revision}).`,
      structured: result,
    };
  },
};

interface Located {
  blockId: string;
  rev: number | undefined;
  unknown: string[];
}

async function locateBlock(ctx: ToolContext, pageId: string, oldStr: string): Promise<Located> {
  const { bundle } = await loadPage(ctx.db, pageId);
  const all = blocksWithText(bundle.page);
  const unknown = (bundle.page.blocks ?? []).filter((b) => UNREPRESENTABLE_TYPES.has(b.type)).map((b) => b.id);
  const hits = all.filter((b) => b.text.includes(oldStr));
  if (!hits.length) {
    throw new ToolError('old_str_not_found', 'old_str does not appear in any block of the page. Re-read the page and copy the exact text.', {
      page_id: pageId,
      unknown_block_ids: unknown,
    });
  }
  if (hits.length > 1) {
    throw new ToolError('old_str_not_unique', 'old_str appears in several blocks. Pass block_id, or include more surrounding text.', {
      block_ids: hits.map((h) => h.block.id),
    });
  }
  return { blockId: hits[0].block.id, rev: hits[0].block.rev, unknown };
}

const editPage: ToolDef = {
  name: 'edit_page',
  title: 'Replace text in a page',
  description:
    'Replaces `old_str` with `new_str` in the plain text of one block. Without block_id the server finds the only block ' +
    'containing old_str. Pass the block `rev` from read_page; if the block changed since, the tool re-reads once and ' +
    'retries when old_str is still there, otherwise it returns block_conflict with the current text. Inline formatting ' +
    'of the edited block is not kept.',
  inputSchema: object({
    page_id: { type: 'string', minLength: 1 },
    old_str: { type: 'string', minLength: 1, maxLength: 5000 },
    new_str: { type: 'string', maxLength: 5000 },
    block_id: { type: 'string' },
    rev: { type: 'integer', minimum: 0 },
    idempotency_key: idempotencyKey,
  }, ['page_id', 'old_str', 'new_str']),
  outputSchema: output({
    revision: { type: 'integer' },
    block_id: { type: 'string' },
    rev: { type: 'integer' },
    unknown_block_ids: { type: 'array', items: { type: 'string' } },
  }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const pageId = String(args.page_id);
    const oldStr = String(args.old_str);
    let blockId = str(args.block_id);
    let rev = num(args.rev);
    let unknown: string[] = [];
    if (!blockId) {
      const found = await locateBlock(ctx, pageId, oldStr);
      blockId = found.blockId;
      unknown = found.unknown;
    }
    const call = (r: number | undefined) =>
      must(ctx.db.rpc<{ revision: number; rev: number }>('edit_block_text', {
        p_page_id: pageId,
        p_block_id: blockId,
        p_old_str: oldStr,
        p_new_str: args.new_str,
        p_rev: r,
        p_idempotency_key: str(args.idempotency_key),
      }));
    let data: { revision: number; rev: number } | null;
    try {
      data = await call(rev);
    } catch (err) {
      if (!(err instanceof ToolError) || err.code !== 'block_conflict') throw err;
      // Re-read once: retry only if old_str is still in that block exactly once.
      const { bundle, row } = await loadPage(ctx.db, pageId);
      const current = blocksWithText(bundle.page).find((b) => b.block.id === blockId);
      const occurrences = current ? current.text.split(oldStr).length - 1 : 0;
      if (!current || occurrences !== 1) {
        throw new ToolError('block_conflict', 'The block changed since you read it and old_str is no longer there.', {
          block_id: blockId,
          rev: current?.block.rev ?? null,
          revision: row.revision,
          text: current ? current.text.slice(0, 2000) : null,
        });
      }
      rev = current.block.rev;
      data = await call(rev);
    }
    const structured: Record<string, unknown> = { revision: data?.revision ?? null, block_id: blockId, rev: data?.rev ?? null };
    if (unknown.length) structured.unknown_block_ids = unknown;
    return { text: `Edited block ${blockId} (revision ${structured.revision}, block rev ${structured.rev}).`, structured };
  },
};

const updateBlock: ToolDef = {
  name: 'update_block',
  title: 'Update block properties',
  description: 'Changes non-text properties of one block (checked, collapsed, language, color, indent, caption, url). Text goes through edit_page.',
  inputSchema: object({
    page_id: { type: 'string', minLength: 1 },
    block_id: { type: 'string', minLength: 1 },
    patch: object({
      checked: { type: 'boolean' },
      collapsed: { type: 'boolean' },
      language: { type: 'string' },
      color: { type: 'string' },
      indent: { type: 'integer', minimum: 0, maximum: 6 },
      caption: { type: 'string' },
      url: { type: 'string' },
    }),
    rev: { type: 'integer', minimum: 0 },
    idempotency_key: idempotencyKey,
  }, ['page_id', 'block_id', 'patch']),
  outputSchema: output({ revision: { type: 'integer' }, rev: { type: 'integer' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    if (!Object.keys(args.patch as object).length) throw new ToolError('invalid_input', 'patch is empty.');
    const data = await must(ctx.db.rpc<{ revision: number; rev: number }>('update_block', {
      p_page_id: args.page_id,
      p_block_id: args.block_id,
      p_patch: args.patch,
      p_rev: num(args.rev),
      p_idempotency_key: str(args.idempotency_key),
    }));
    const structured = { revision: data?.revision ?? null, rev: data?.rev ?? null };
    return { text: `Updated block ${String(args.block_id)} (revision ${structured.revision}).`, structured };
  },
};

function findProperty(db: Database, ref: string): DbProperty | undefined {
  return db.properties.find((p) => p.id === ref) ?? db.properties.find((p) => p.name === ref) ??
    db.properties.find((p) => p.name.toLowerCase() === ref.toLowerCase());
}

/** Validates cells by property type (lib/agentInput.ts) and keys them by property id. */
function validateCells(db: Database, cells: Record<string, unknown>): Record<string, AgentCellInput> {
  const out: Record<string, AgentCellInput> = {};
  for (const [ref, value] of Object.entries(cells)) {
    const prop = findProperty(db, ref);
    if (!prop) throw new ToolError('invalid_input', `Unknown property "${ref}".`, { property: ref });
    try {
      out[prop.id] = validateAgentCell(prop.type, value);
    } catch (err) {
      const code = err instanceof Error && err.message === 'computed_property' ? 'computed_property' : 'invalid_input';
      throw new ToolError(code, code === 'computed_property'
        ? `"${prop.name}" is computed (${prop.type}) and cannot be written.`
        : `The value for "${prop.name}" does not match its type (${prop.type}).`, { property: prop.name, type: prop.type });
    }
  }
  if (!Object.keys(out).length) throw new ToolError('invalid_input', 'cells is empty.');
  return out;
}

const cellsSchema = { type: 'object', additionalProperties: { $ref: '#/$defs/AgentCellInput' }, description: 'Property name (or id) -> value.' } as const;

const updateRow: ToolDef = {
  name: 'update_row',
  title: 'Update database row cells',
  description:
    'Sets cells of one row, by property name. Identify the row by row_id or by its page_id. Pass the row `rev` from ' +
    'query_database; on block_conflict the current values are returned and nothing is retried. Computed properties cannot be written.',
  inputSchema: withDefs(object({
    database_id: { type: 'string', minLength: 1 },
    row_id: { type: 'string' },
    page_id: { type: 'string' },
    cells: cellsSchema,
    rev: { type: 'integer', minimum: 0 },
    idempotency_key: idempotencyKey,
  }, ['database_id', 'cells'])),
  outputSchema: output({ revision: { type: 'integer' }, row_id: { type: 'string' }, rev: { type: 'integer' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const dbId = String(args.database_id);
    const { bundle } = await loadPage(ctx.db, dbId);
    const db = bundle.page.database;
    if (!db) throw new ToolError('invalid_input', `Page ${dbId} is not a database.`);
    const rowRef = str(args.row_id) ?? str(args.page_id);
    if (!rowRef) throw new ToolError('invalid_input', 'Pass row_id or page_id.');
    const row = db.rows.find((r) => r.id === args.row_id || r.pageId === args.page_id);
    if (!row) throw new ToolError('not_found', `Row ${rowRef} is not in database ${dbId}.`);
    const cells = validateCells(db, args.cells as Record<string, unknown>);
    let data: { revision: number; rev: number } | null;
    try {
      data = await must(ctx.db.rpc<{ revision: number; rev: number }>('set_row_cells', {
        p_db_page_id: dbId,
        p_row_id: row.id,
        p_cells: cells,
        p_rev: num(args.rev),
        p_idempotency_key: str(args.idempotency_key),
      }));
    } catch (err) {
      if (!(err instanceof ToolError) || err.code !== 'block_conflict') throw err;
      const fresh = await loadPage(ctx.db, dbId);
      const freshDb = fresh.bundle.page.database;
      const freshRow = freshDb?.rows.find((r) => r.id === row.id);
      const current: Record<string, string> = {};
      if (freshDb && freshRow) {
        for (const id of Object.keys(cells)) {
          const prop = freshDb.properties.find((p) => p.id === id);
          if (prop) current[prop.name] = displayCell(freshRow, prop, freshDb, fresh.bundle.pages);
        }
      }
      throw new ToolError('block_conflict', 'The row changed since you read it. Check the current values and retry with the new rev.', {
        row_id: row.id,
        rev: freshRow?.rev ?? null,
        revision: fresh.row.revision,
        current,
      });
    }
    const structured = { revision: data?.revision ?? null, row_id: row.id, rev: data?.rev ?? null };
    return { text: `Updated ${plural(Object.keys(cells).length, 'cell')} of row ${row.id} (revision ${structured.revision}).`, structured };
  },
};

const addRow: ToolDef = {
  name: 'add_row',
  title: 'Add a database row',
  description: 'Creates a row (and its page) in a database, with cells by property name and optional Markdown content for the row page.',
  inputSchema: withDefs(object({
    database_id: { type: 'string', minLength: 1 },
    cells: cellsSchema,
    markdown: { type: 'string', maxLength: 200_000 },
    idempotency_key: idempotencyKey,
  }, ['database_id', 'cells'])),
  outputSchema: output({ row_id: { type: 'string' }, page_id: { type: 'string' }, revision: { type: 'integer' } }),
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const dbId = String(args.database_id);
    const { bundle } = await loadPage(ctx.db, dbId);
    const db = bundle.page.database;
    if (!db) throw new ToolError('invalid_input', `Page ${dbId} is not a database.`);
    const cells = validateCells(db, args.cells as Record<string, unknown>);
    const blocks = typeof args.markdown === 'string' && args.markdown.trim() ? markdownToAgentBlocks(args.markdown) : [];
    const data = await must(ctx.db.rpc<{ row_id: string; page_id: string; revision: number }>('add_row', {
      p_db_page_id: dbId,
      p_cells: cells,
      p_blocks: blocks,
      p_idempotency_key: str(args.idempotency_key),
    }));
    const structured = { row_id: data?.row_id ?? null, page_id: data?.page_id ?? null, revision: data?.revision ?? null };
    return { text: `Added row ${structured.row_id} (page ${structured.page_id}).`, structured };
  },
};

const addComment: ToolDef = {
  name: 'add_comment',
  title: 'Comment on a page or block',
  description: 'Adds a comment to a page, or to one block with block_id. Mentioning an agent never makes it act.',
  inputSchema: object({
    page_id: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1, maxLength: 10_000 },
    block_id: { type: 'string' },
  }, ['page_id', 'body']),
  outputSchema: output({ comment_id: { type: 'string' } }),
  annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<string>('add_page_comment', {
      p_page_id: args.page_id,
      p_body: args.body,
      p_block_id: str(args.block_id),
    }));
    return { text: `Comment ${String(data)} added.`, structured: { comment_id: data } };
  },
};

export const writeTools: ToolDef[] = [appendBlocks, editPage, updateBlock, updateRow, addRow, addComment];
