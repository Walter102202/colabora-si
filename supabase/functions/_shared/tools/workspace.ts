// Compact workspace-only tools. SQL repeats validation and authorization for direct RPC callers.
import { must, ToolError } from '../db.ts';
import type { JsonSchema } from '../jsonSchema.ts';
import { markdownToAgentBlocks } from '../lib/agentInput.ts';
import type { ToolDef } from '../mcp.ts';
import { object, output, pageUrl, withDefs, WRITE_IDEMPOTENT } from './common.ts';

const ref: JsonSchema = { type: 'string', minLength: 1 };
const title: JsonSchema = { type: 'string', maxLength: 1000 };
const content = {
  markdown: { type: 'string', maxLength: 200_000 },
  blocks: { type: 'array', maxItems: 200, items: { $ref: '#/$defs/AgentBlockInput' } },
} satisfies Record<string, JsonSchema>;
const parent = { parent_id: { type: ['string', 'null'], description: 'Writable parent. Only a human session can use null (also supply workspace_id).' }, workspace_id: ref } satisfies Record<string, JsonSchema>;
const option = { anyOf: [{ type: 'string' }, object({ name: ref, rename: ref, delete: { type: 'boolean' } }, ['name'])] } satisfies JsonSchema;
const properties: JsonSchema = { type: 'array', maxItems: 50, items: object({ name: ref, rename: ref, delete: { type: 'boolean' },
  type: { type: 'string', enum: ['text', 'number', 'checkbox', 'date', 'url', 'email', 'phone', 'select', 'multiSelect', 'status', 'person', 'files'] },
  options: { type: 'array', items: option },
}, ['name']), description: 'Name is a property name or id. Default title property is Name. Add with type; rename/delete existing properties. Options accept names or {name,rename/delete}.' };
const view: JsonSchema = object({ name: ref, rename: ref, type: { type: 'string', enum: ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'] },
  group_by: ref, date_property: ref, end_date_property: ref,
  sorts: { type: 'array', items: object({ property: ref, direction: { type: 'string', enum: ['asc', 'desc'] } }, ['property']) },
  filters: { type: 'array', items: object({ property: ref, operator: { type: 'string', enum: ['is', 'isNot', 'contains', 'notContains', 'isEmpty', 'isNotEmpty', 'gt', 'lt', 'checked', 'unchecked'] }, value: { type: 'string' } }, ['property', 'operator']) },
}, ['name']);
const rows: JsonSchema = { type: 'array', maxItems: 100, items: object({ cells: { type: 'object', additionalProperties: { $ref: '#/$defs/AgentCellInput' } }, ...content }, ['cells']),
  description: 'Cells by property name or id, using typed values such as {text:"Acme"}, {select:"New"}. New select options are created automatically.' };

function convertContent(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (typeof out.markdown === 'string') {
    if (out.blocks !== undefined) throw new ToolError('invalid_input', 'Pass markdown or blocks, not both.', null, 'Remove one content field.');
    out.blocks = markdownToAgentBlocks(out.markdown);
    delete out.markdown;
  }
  return out;
}
function tool(name: string, description: string, fields: Record<string, JsonSchema>, required: string[]): ToolDef {
  return {
    name, title: name.replaceAll('_', ' '), description,
    inputSchema: withDefs(object({ ...fields, idempotency_key: { type: 'string', minLength: 1, maxLength: 180, description: 'Unique per write. Reuse only to retry the same write.' } }, [...required, 'idempotency_key'])),
    outputSchema: output({ id: ref, page_id: ref, url: ref, revision: { type: 'integer' } }),
    annotations: WRITE_IDEMPOTENT,
    async handler(args, ctx) {
      const { idempotency_key, ...rest } = args;
      const input = convertContent(rest);
      if (Array.isArray(input.rows)) input.rows = input.rows.map(r => convertContent(r as Record<string, unknown>));
      const result = await must(ctx.db.rpc<Record<string, unknown>>(name, { p_input: input, p_idempotency_key: idempotency_key }));
      if (!result || typeof result.id !== 'string') throw new ToolError('internal', 'The write returned no page identity.');
      return { text: `${name}: ${result.id} (revision ${result.revision}).`, structured: { ...result, url: pageUrl(ctx.appUrl, result.id) } };
    },
  };
}
export const workspaceTools: ToolDef[] = [
  tool('create_page', 'Create a page with Markdown or AgentBlockInput under a writable parent. No task needed.', { ...parent, title, icon: { type: ['string', 'null'], maxLength: 100 }, ...content }, ['title']),
  tool('update_page', 'Update title or icon.', { page_id: ref, title, icon: { type: ['string', 'null'], maxLength: 100 } }, ['page_id']),
  tool('move_page', 'Move a page; returns previous_parent_id for undo. Position applies to root order.', { page_id: ref, ...parent, position: { type: 'integer', minimum: 0 } }, ['page_id', 'parent_id']),
  tool('duplicate_page', 'Duplicate a page, optionally its children. Databases include their row pages.', { page_id: ref, ...parent, include_children: { type: 'boolean' } }, ['page_id']),
  tool('archive_page', 'Archive a page and its subtree without deleting content.', { page_id: ref }, ['page_id']),
  tool('restore_page', 'Restore an archived page and its subtree.', { page_id: ref }, ['page_id']),
  tool('create_database', 'Create a complete database in ONE call: title, properties, views and up to 100 rows. Default title property: Name. Set a board group_by to a select/status property name.', { ...parent, title, icon: { type: ['string', 'null'] }, properties, views: { type: 'array', minItems: 1, items: view }, rows }, ['title']),
  tool('update_database', 'Add, rename or delete properties and options by name/id. In-use options cannot be removed until their cells are changed.', { database_id: ref, properties }, ['database_id', 'properties']),
  tool('set_view', 'Create or update a view by name/id, with filters, sorts and grouping by property name.', { database_id: ref, view }, ['database_id', 'view']),
  tool('delete_view', 'Remove a view by name/id; keeps at least one view.', { database_id: ref, name: ref }, ['database_id', 'name']),
  tool('add_rows', 'Atomically add up to 100 rows. One invalid row rolls back the entire batch.', { database_id: ref, rows }, ['database_id', 'rows']),
  tool('delete_row', 'Archive the row page; its data is retained and restore_page makes it visible again.', { database_id: ref, row_id: ref }, ['database_id', 'row_id']),
];
