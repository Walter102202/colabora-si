// In-memory fake of the workspace MCP server with the task tools.
// Same interface as createMcpClient; records every call in `calls`.

const str = { type: "string" };
const obj = { type: "object" };
/** @param {Record<string, object>} properties @param {string[]} [required] */
const schema = (properties, required = []) => ({ type: "object", properties, required });

/** Tool definitions as `tools/list` returns them. */
export const STUB_TOOLS = [
  { name: "wait_for_my_tasks", description: "Wait until any of my tasks needs me", inputSchema: schema({ after: str, timeout_s: { type: "integer" } }) },
  { name: "claim_task", description: "Claim a task and start a run", inputSchema: schema({ task_id: str, harness: str }, ["harness"]) },
  { name: "get_task", description: "Get task brief, artifacts and recent activity", inputSchema: schema({ task_id: str }, ["task_id"]) },
  { name: "heartbeat", description: "Report liveness and pull pending messages", inputSchema: schema({ run_id: str, after_seq: { type: "integer" }, usage: obj }, ["run_id"]) },
  { name: "wait_for_task", description: "Wait until a task changes", inputSchema: schema({ task_id: str, after_seq: { type: "integer" }, timeout_s: { type: "integer" }, run_id: str }, ["task_id"]) },
  { name: "post_activity", description: "Log an activity on my run", inputSchema: schema({ run_id: str, type: str, body: obj }, ["run_id", "type", "body"]) },
  { name: "add_artifact", description: "Declare a deliverable", inputSchema: schema({ run_id: str, kind: str, ref: str, title: str, satisfies: { type: "array", items: str } }, ["run_id", "kind", "ref", "title", "satisfies"]) },
  { name: "request_input", description: "Ask the human a question", inputSchema: schema({ run_id: str, question: str }, ["run_id", "question"]) },
  { name: "request_approval", description: "Request approval for an irreversible action", inputSchema: schema({ run_id: str, action: str, params: obj, question: str }, ["run_id", "action", "params", "question"]) },
  { name: "submit_for_review", description: "Submit the task for review", inputSchema: schema({ run_id: str, summary: str, artifact_ids: { type: "array", items: str } }, ["run_id", "summary", "artifact_ids"]) },
  { name: "end_run", description: "End my run", inputSchema: schema({ run_id: str, status: str, error: str, usage: obj }, ["run_id", "status"]) },
  { name: "ack_stop", description: "Acknowledge a stop request", inputSchema: schema({ run_id: str }, ["run_id"]) },
  { name: "read_page", description: "Read page as Markdown", inputSchema: schema({ page_id: str }, ["page_id"]) },
  { name: "append_blocks", description: "Append blocks to a page", inputSchema: schema({ page_id: str, markdown: str }, ["page_id"]) },
  { name: "edit_page", description: "Replace text in a page", inputSchema: schema({ page_id: str, old_str: str, new_str: str }, ["page_id", "old_str", "new_str"]) },
];

/**
 * @typedef {(args: Record<string, any>) => Record<string, any> | {isError: true, data: Record<string, any>}} Handler
 * @param {{
 *   tasks?: Record<string, any>[], heartbeats?: Record<string, any>[], waits?: Record<string, any>[],
 *   handlers?: Record<string, Handler>, instructions?: string,
 * }} [opts]
 */
export function createStubMcp({ tasks = [], heartbeats = [], waits = [], handlers = {}, instructions } = {}) {
  /** @type {{name: string, args: Record<string, any>}[]} */
  const calls = [];
  let seq = 10;
  let delivered = false;
  const hbQueue = [...heartbeats];
  const waitQueue = [...waits];

  /** @type {Record<string, Handler>} */
  const defaults = {
    wait_for_my_tasks: () => {
      const out = { changed: !delivered && tasks.length > 0, tasks: delivered ? [] : tasks, next_cursor: "cursor-1" };
      delivered = true;
      return out;
    },
    claim_task: (a) => ({
      task_id: a.task_id,
      run_id: `run-${a.task_id}`,
      context_id: `ctx-${a.task_id}`,
      row_page_id: `row-${a.task_id}`,
      brief: { goal: "Summarize the sources on the row page", done_when: [{ id: "c1", text: "A summary section exists", check: "human" }] },
      artifacts: [],
      recent_activities: [{ seq: 1, type: "prompt", signal: "start", excerpt: "Task created" }],
    }),
    get_task: (a) => ({ task: { task_id: a.task_id, state: "working" }, brief: {}, artifacts: [], approvals_pending: [], activities: [] }),
    heartbeat: () => hbQueue.shift() ?? { stop_requested: false, pending_prompts: [], brief_stale: false },
    wait_for_task: (a) => waitQueue.shift() ?? { changed: false, stop_requested: false, activities: [], next_seq: a.after_seq ?? seq },
    post_activity: () => ({ activity_id: `act-${++seq}`, seq, task_state: "working" }),
    add_artifact: () => ({ artifact_id: "art-1", version: 1 }),
    request_input: () => ({ approval_id: "input-1", status: "pending" }),
    request_approval: () => ({ approval_id: "appr-1", action_hash: "hash-1", status: "pending" }),
    submit_for_review: () => ({ task_state: "ready_for_review" }),
    end_run: () => ({ task_state: "queued" }),
    ack_stop: () => ({ ok: true }),
    read_page: (a) => ({ page_id: a.page_id, title: "Row", revision: 1, markdown: "# Row\n\nSources: ... <!-- block:b0 -->", blocks: [{ id: "b0", rev: 1, type: "paragraph", indent: 0, markdown: "Sources: ..." }] }),
    append_blocks: () => ({ revision: 2, block_ids: ["b1"] }),
    edit_page: (a) => ({ revision: 3, block_id: a.block_id ?? "b0", rev: 2 }),
  };

  return {
    calls,
    instructions,
    async initialize() {},
    async listTools() {
      return STUB_TOOLS;
    },
    /** @param {string} name @param {Record<string, any>} args */
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      const handler = handlers[name] ?? defaults[name];
      if (!handler) return { isError: true, data: { code: "not_found" }, text: `unknown tool ${name}` };
      const out = handler(args);
      if (out && out.isError === true) return { isError: true, data: out.data, text: JSON.stringify(out.data) };
      return { isError: false, data: out, text: JSON.stringify(out) };
    },
  };
}
