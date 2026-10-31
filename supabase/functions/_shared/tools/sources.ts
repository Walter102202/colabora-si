// Page source tools. An agent declares what a page was built from; a check compares and reports, and never edits a page.
import { must } from '../db.ts';
import { blocksWithText, pageToMarkdown } from '../pageToMarkdown.ts';
import type { Page } from '../lib/types.ts';
import type { ToolContext, ToolDef } from '../mcp.ts';
import { object, output, str, WRITE } from './common.ts';
import type { Row } from './taskData.ts';

const MAX_SOURCE_CHARS = 20_000;
const runId = { type: 'string', minLength: 1 };
const usage = object({
  input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 },
  model: { type: 'string' }, cost_usd: { type: 'number', minimum: 0 },
});

const declareSources: ToolDef = {
  name: 'declare_sources', title: 'Declare what a page was built from',
  description: 'Records the pages, blocks or URLs a page depends on, with the version observed now. If one changes later, the page is marked and checked. A source you cannot read answers not_found; a cycle answers source_cycle.',
  inputSchema: object({
    run_id: runId, page_id: { type: 'string', minLength: 1 },
    sources: { type: 'array', minItems: 1, maxItems: 20, items: object({ page_id: { type: 'string' }, block_id: { type: 'string' }, url: { type: 'string', maxLength: 2000 } }) },
  }, ['run_id', 'page_id', 'sources']),
  outputSchema: output({ declared: { type: 'integer' } }), annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('declare_sources', { p_page_id: args.page_id, p_sources: args.sources, p_run_id: args.run_id }));
    return { text: 'Sources recorded.', structured: data ?? {} };
  },
};

const reportSourceCheck: ToolDef = {
  name: 'report_source_check', title: 'Report a source check',
  description: 'Request tool: says whether a page still agrees with its changed sources and closes the request. A check never edits a page: a discrepancy goes to a person.',
  inputSchema: object({
    run_id: runId, verdict: { type: 'string', enum: ['current', 'discrepancy'] },
    checked: { type: 'array', minItems: 1, maxItems: 10, items: object({ id: { type: 'string' }, fingerprint: { type: 'string' }, revision: { type: 'integer' } }, ['id', 'fingerprint', 'revision']) },
    summary: { type: 'string', maxLength: 1000 },
    items: { type: 'array', maxItems: 10, items: object({ source_id: { type: 'string' }, source_says: { type: 'string', maxLength: 300 }, page_says: { type: 'string', maxLength: 300 } }, ['source_id']) },
    usage,
  }, ['run_id', 'verdict', 'checked']),
  outputSchema: output({ verdict: { type: 'string' }, discrepancy_id: { type: ['string', 'null'] }, checked: { type: 'integer' }, task_state: { type: 'string' } }), annotations: WRITE,
  async handler(args, ctx) {
    const data = await must(ctx.db.rpc<Row>('report_source_check', { p_run_id: args.run_id, p_verdict: args.verdict, p_checked: args.checked,
      p_summary: str(args.summary), p_items: args.items ?? [], p_usage: args.usage }));
    return { text: args.verdict === 'current' ? 'The page agrees with its sources.' : 'A person will settle the discrepancy.', structured: data ?? {} };
  },
};

function sourceText(data: unknown, blockId: string | null, appUrl: string): string {
  if (!data) return '';
  const page = data as Page;
  if (blockId) return (blocksWithText(page).find((b) => b.block.id === blockId)?.text ?? '').slice(0, MAX_SOURCE_CHARS);
  return pageToMarkdown(page, { pages: {}, syncedBlocks: {}, linkBase: appUrl, maxChars: MAX_SOURCE_CHARS }).markdown.slice(0, MAX_SOURCE_CHARS);
}

/** The check as text: the model compares Markdown, and the page JSON never leaves this function. */
export function sourceCheckView(data: Row, appUrl: string): Row {
  const page = data.page as Row;
  const sources = (data.sources ?? []) as Row[];
  return {
    kind: 'source_check', task_id: data.task_id,
    page: { id: page.id, title: page.title, text: sourceText(page.data, null, appUrl) },
    sources: sources.map((s) => ({
      id: s.id, title: s.title, fingerprint: s.fingerprint, revision: s.revision, observed_at: s.observed_at, deleted: !s.data,
      text: sourceText(s.data, s.block_id ? String(s.block_id) : null, appUrl), files: s.files ?? [],
    })),
  };
}

/** A check carries no page grant: its input comes from a definer RPC, never from a page read. */
export async function sourceCheckRequest(taskId: string, ctx: ToolContext) {
  const data = await must(ctx.db.rpc<Row>('source_check_context', { p_task_id: taskId })) ?? {};
  return { text: 'Sources ready to compare.', structured: sourceCheckView(data, ctx.appUrl) };
}

export const sourceTools: ToolDef[] = [declareSources, reportSourceCheck];
