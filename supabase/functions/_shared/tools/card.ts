// The MCP Apps task card (SEP-1865, specification 2026-01-26) and the human-facing task tools.
// The card is one self-contained HTML document served as a ui:// resource; get_task, decide_approval,
// close_task and list_waiting_on_me point at it through `_meta.ui.resourceUri` and return the data it
// renders as structuredContent. The tools call the control RPCs the row panel calls (decide_approval,
// close_task) as the person; an agent gets humans_only. decide_approval and close_task need a direct
// session in the database: an OAuth chat connection gets direct_session_required with the task link.
import { type Db, type Filter, messageFor, must, ToolError } from '../db.ts';
import type { ResourceProvider, ToolContext, ToolDef } from '../mcp.ts';
import { CARD_HTML } from '../cardHtml.ts';
import type { JsonSchema } from '../jsonSchema.ts';
import { num, object, output, plural, READ, str, WRITE } from './common.ts';
import { loadTask, loadTaskBundle, type Row, TASK_COLUMNS, type TaskBundle } from './taskData.ts';

export const CARD_URI = 'ui://colabora/task-card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';

/** On a tool: a host that supports MCP Apps renders the result with the card. The flat key is the pre-GA spelling of the spec; the openai key is ChatGPT's alias. */
export const CARD_TOOL_META: Record<string, unknown> = {
  ui: { resourceUri: CARD_URI },
  'ui/resourceUri': CARD_URI,
  'openai/outputTemplate': CARD_URI,
};

/** On the resource: the card has no external origins (default CSP) and prefers the host's card border. */
export const CARD_RESOURCE_META: Record<string, unknown> = { ui: { prefersBorder: true } };

/** Output schema of the card data (TaskCardData in lib/agentCard.ts). */
export const CARD_OUTPUT: Record<string, JsonSchema> = {
  kind: { type: 'string', enum: ['task'] },
  run: { type: ['object', 'null'] },
  approval: { type: ['object', 'null'] },
  artifact: { type: ['object', 'null'] },
  review: { type: ['object', 'null'] },
  subtasks: { type: 'array', items: { type: 'object' } },
  agents: { type: 'array', items: { type: 'object' } },
  app_url: { type: 'string' },
};

const RUN_COLUMNS =
  'id,task_id,agent_id,harness,brief_version,status,stop_requested_at,stop_acked_at,last_signal_at,stale_at,waiting_on_task_id,' +
  'input_tokens,output_tokens,model,cost_usd,cost_kind,error_message,started_at,ended_at';
const REVIEW_COLUMNS =
  'id,task_id,run_id,reviewer_type,reviewer_id,artifact_id,artifact_version,brief_version,verdict,findings,evidence,' +
  'outdated_by,outdated_at,created_at';
const AGENT_COLUMNS = 'id,name,role,capabilities';
const WAITING_APPROVAL_COLUMNS = 'id,task_id,kind,action,question,options,expires_at,created_at';

export type WaitingReason = 'approval' | 'input' | 'review';
const REASON_LABEL: Record<WaitingReason, string> = {
  approval: 'needs your approval',
  input: 'has a question for you',
  review: 'ready for your review',
};

export interface TaskCard extends TaskBundle {
  kind: 'task';
  run: Row | null;
  approval: Row | null;
  artifact: Row | null;
  review: Row | null;
  subtasks: { task: Row; run: Row | null; agent_name: string | null }[];
  agents: Row[];
  app_url: string;
}

/** Deep link to a task in the app (the app's taskUrl: /p/<page>?task=<id>). */
export function taskLink(appUrl: string, pageId: string, taskId: string): string {
  return `${appUrl}/p/${encodeURIComponent(pageId)}?task=${encodeURIComponent(taskId)}`;
}

/** The task link plus the fragment the row panel focuses: one tap lands on the approval. */
export function approvalLink(appUrl: string, pageId: string, taskId: string, approvalId: string): string {
  return `${taskLink(appUrl, pageId, taskId)}#approval-${encodeURIComponent(approvalId)}`;
}

function unique(ids: unknown[]): string[] {
  return [...new Set(ids.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

async function selectIn(db: Db, table: string, columns: string, col: string, ids: string[], extra: Filter[] = []): Promise<Row[]> {
  if (!ids.length) return [];
  return (await must(db.select<Row>({ table, columns, filters: [{ col, op: 'in', value: ids }, ...extra] }))) ?? [];
}

/** The current deliverable: highest version, then the latest. */
export function currentArtifact(artifacts: Row[]): Row | null {
  const sorted = artifacts.slice().sort((a, b) =>
    Number(b.version ?? 0) - Number(a.version ?? 0) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  );
  return sorted[0] ?? null;
}

/** Everything the card renders about one task, read under the caller's RLS. */
export async function loadTaskCard(
  db: Db,
  taskId: string,
  appUrl: string,
  opts: { activitiesLimit?: number; includeEphemeral?: boolean } = {},
): Promise<TaskCard> {
  const bundle = await loadTaskBundle(db, taskId, opts);
  const task = bundle.task;
  const [runs, reviews, subtaskRows] = await Promise.all([
    typeof task.active_run_id === 'string' ? selectIn(db, 'agent_runs', RUN_COLUMNS, 'id', [task.active_run_id]) : Promise.resolve([]),
    must(db.select<Row>({
      table: 'agent_reviews',
      columns: REVIEW_COLUMNS,
      filters: [{ col: 'task_id', op: 'eq', value: taskId }],
      order: [{ column: 'created_at', ascending: false }],
      limit: 1,
    })),
    must(db.select<Row>({
      table: 'agent_tasks',
      columns: TASK_COLUMNS,
      filters: [{ col: 'parent_task_id', op: 'eq', value: taskId }],
      order: [{ column: 'created_at', ascending: true }],
      limit: 100,
    })),
  ]);
  const subtasks = subtaskRows ?? [];
  const review = reviews?.[0] ?? null;
  const subRuns = await selectIn(db, 'agent_runs', RUN_COLUMNS, 'id', unique(subtasks.map((s) => s.active_run_id)));
  const agentIds = unique([
    task.delegate_agent_id,
    ...subtasks.map((s) => s.delegate_agent_id),
    review?.reviewer_type === 'agent' ? review.reviewer_id : null,
  ]);
  const agents = await selectIn(db, 'agents', AGENT_COLUMNS, 'id', agentIds);
  const agentName = (id: unknown): string | null => {
    const name = agents.find((a) => a.id === id)?.name;
    return typeof name === 'string' ? name : null;
  };
  return {
    kind: 'task',
    ...bundle,
    run: runs[0] ?? null,
    approval: bundle.approvals_pending[0] ?? null,
    artifact: currentArtifact(bundle.artifacts),
    review,
    subtasks: subtasks.map((s) => ({
      task: s,
      run: subRuns.find((r) => r.id === s.active_run_id) ?? null,
      agent_name: agentName(s.delegate_agent_id),
    })),
    agents,
    app_url: appUrl,
  };
}

function humanOnly(ctx: ToolContext): void {
  if (ctx.principal.type !== 'human') throw new ToolError('humans_only', messageFor('humans_only'));
}

/** A control RPC as the person. When the database wants a direct session, the error carries the task link. */
async function controlRpc(ctx: ToolContext, fn: string, params: Record<string, unknown>, task: Row, approvalId?: string): Promise<Row> {
  try {
    return (await must(ctx.db.rpc<Row>(fn, params))) ?? {};
  } catch (err) {
    if (err instanceof ToolError && err.code === 'direct_session_required') {
      const pageId = String(task.row_page_id), taskId = String(task.id);
      const url = approvalId ? approvalLink(ctx.appUrl, pageId, taskId, approvalId) : taskLink(ctx.appUrl, pageId, taskId);
      throw new ToolError(err.code, `${err.message} Open the task in colabora to decide there.`, { task_id: task.id, url });
    }
    throw err;
  }
}

const decideApproval: ToolDef = {
  name: 'decide_approval',
  title: 'Decide what an agent asked',
  description:
    'People only. Approves, edits, rejects or ignores an action an agent asked approval for, or answers its question ' +
    '(respond, with response.text). The agent continues with your decision. Returns the refreshed task card.',
  inputSchema: object({
    approval_id: { type: 'string', minLength: 1 },
    decision: { type: 'string', enum: ['approve', 'reject', 'edit', 'respond', 'ignore'] },
    response: { type: 'object', description: 'respond: {text}; edit: {params} with the changed parameters' },
  }, ['approval_id', 'decision']),
  outputSchema: output({ status: { type: 'string' }, task: { type: 'object' }, ...CARD_OUTPUT }),
  annotations: WRITE,
  _meta: CARD_TOOL_META,
  async handler(args, ctx) {
    humanOnly(ctx);
    const approvalId = String(args.approval_id);
    const approval = (await selectIn(ctx.db, 'agent_approvals', 'id,task_id,status', 'id', [approvalId]))[0];
    if (!approval) throw new ToolError('not_found', `Approval ${approvalId} was not found, or you have no access to it.`);
    const task = await loadTask(ctx.db, String(approval.task_id));
    const data = await controlRpc(ctx, 'decide_approval', {
      p_approval_id: approvalId,
      p_decision: args.decision,
      p_response: args.response ?? null,
    }, task, approvalId);
    const card = await loadTaskCard(ctx.db, String(task.id), ctx.appUrl);
    return {
      text: `Decision recorded: ${String(args.decision)}. Task "${String(card.task.title || card.task.id)}" is now ${String(card.task.state)}.`,
      structured: { status: data.status ?? 'decided', ...card },
    };
  },
};

const closeTask: ToolDef = {
  name: 'close_task',
  title: 'Close a task',
  description:
    'People only. Accepts the deliverable of a task in ready_for_review and closes it, or closes it without accepting ' +
    '(rejected; also allowed while the task waits for input). Nothing is reverted; an active run is told to stop. ' +
    'Returns the refreshed task card.',
  inputSchema: object({
    task_id: { type: 'string', minLength: 1 },
    acceptance: { type: 'string', enum: ['accepted', 'rejected'] },
    note: { type: 'string', maxLength: 4000 },
  }, ['task_id', 'acceptance']),
  outputSchema: output({ task_state: { type: 'string' }, task: { type: 'object' }, ...CARD_OUTPUT }),
  annotations: WRITE,
  _meta: CARD_TOOL_META,
  async handler(args, ctx) {
    humanOnly(ctx);
    const task = await loadTask(ctx.db, String(args.task_id));
    await controlRpc(ctx, 'close_task', { p_task_id: task.id, p_acceptance: args.acceptance, p_note: str(args.note) }, task);
    const card = await loadTaskCard(ctx.db, String(task.id), ctx.appUrl);
    return {
      text: `Task "${String(card.task.title || card.task.id)}" closed (${String(args.acceptance)}).`,
      structured: { task_state: card.task.state, ...card },
    };
  },
};

const listWaitingOnMe: ToolDef = {
  name: 'list_waiting_on_me',
  title: 'List what waits on me',
  description:
    'People only. Your tasks that need you: approvals and questions from agents (input_required) and deliverables ' +
    'ready for review. Compact rows with a link to each task; get_task has the details.',
  inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }),
  outputSchema: output({
    kind: { type: 'string', enum: ['waiting'] },
    items: { type: 'array', items: { type: 'object' } },
    app_url: { type: 'string' },
  }),
  annotations: READ,
  cacheTtlMs: 0,
  _meta: CARD_TOOL_META,
  async handler(args, ctx) {
    humanOnly(ctx);
    const tasks = await must(ctx.db.select<Row>({
      table: 'agent_tasks',
      columns: TASK_COLUMNS,
      filters: [
        { col: 'owner_user_id', op: 'eq', value: ctx.principal.userId },
        { col: 'state', op: 'in', value: ['input_required', 'ready_for_review'] },
      ],
      order: [{ column: 'updated_at', ascending: false }],
      limit: num(args.limit) ?? 20,
    })) ?? [];
    const ids = unique(tasks.map((t) => t.id));
    const [approvals, agents] = await Promise.all([
      selectIn(ctx.db, 'agent_approvals', WAITING_APPROVAL_COLUMNS, 'task_id', ids, [{ col: 'status', op: 'eq', value: 'pending' }]),
      selectIn(ctx.db, 'agents', 'id,name', 'id', unique(tasks.map((t) => t.delegate_agent_id))),
    ]);
    const items: Row[] = [];
    for (const t of tasks) {
      const approval = approvals
        .filter((a) => a.task_id === t.id)
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0] ?? null;
      let reason: WaitingReason | null = null;
      if (approval) reason = approval.kind === 'action' ? 'approval' : 'input';
      else if (t.state === 'ready_for_review') reason = 'review';
      else if (t.waiting_on === 'human' || t.waiting_on == null) reason = 'input';
      if (!reason) continue; // waiting on the Lead or on another agent
      const agent = agents.find((a) => a.id === t.delegate_agent_id);
      items.push({
        task_id: t.id,
        title: t.title,
        state: t.state,
        review_state: t.review_state,
        waiting_on: t.waiting_on,
        reason,
        row_page_id: t.row_page_id,
        agent_name: typeof agent?.name === 'string' ? agent.name : null,
        last_activity_at: t.last_activity_at,
        approval: approval
          ? {
            id: approval.id,
            kind: approval.kind,
            action: approval.action ?? null,
            question: approval.question ?? '',
            options: approval.options ?? [],
            expires_at: approval.expires_at,
          }
          : null,
        url: taskLink(ctx.appUrl, String(t.row_page_id), String(t.id)),
      });
    }
    const count = (r: WaitingReason) => items.filter((i) => i.reason === r).length;
    const lines = items.map((i) => {
      const approval = i.approval as { question?: string } | null;
      const question = approval?.question ? ` (${approval.question})` : '';
      return `- ${String(i.title || i.task_id)}: ${REASON_LABEL[i.reason as WaitingReason]}${question} ${String(i.url)}`;
    });
    const text = items.length
      ? `${plural(items.length, 'task')} waiting on you: ${count('approval')} to approve, ${count('input')} with a question, ` +
        `${count('review')} to review.\n${lines.join('\n')}`
      : 'Nothing is waiting on you.';
    return { text, structured: { kind: 'waiting', items, app_url: ctx.appUrl } };
  },
};

export const cardTools: ToolDef[] = [decideApproval, closeTask, listWaitingOnMe];

/** Adds the card to a resource provider: listed first, read by its exact uri. */
export function withTaskCard(base: ResourceProvider): ResourceProvider {
  const entry = {
    uri: CARD_URI,
    name: 'task-card',
    title: 'Task card (MCP App)',
    mimeType: CARD_MIME,
    description: 'Interactive card a chat host renders for get_task, decide_approval, close_task and list_waiting_on_me.',
    _meta: CARD_RESOURCE_META,
  };
  return {
    templates: base.templates,
    async list(ctx) {
      return [entry, ...(await base.list(ctx))];
    },
    read(uri, ctx) {
      if (uri === CARD_URI) return Promise.resolve({ uri, mimeType: CARD_MIME, text: CARD_HTML, _meta: CARD_RESOURCE_META });
      return base.read(uri, ctx);
    },
  };
}
