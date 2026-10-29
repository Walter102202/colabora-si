// Stateful protocol double. Each branch models the corresponding task/partial-write RPC.
import { McpError } from "../mcpClient.mjs";
import { WORLD_TOOLS } from "./stub-world-tools.mjs";

export const CLAUDE_CODE = "agent-claude";
export const CODEX = "agent-codex";
export const PLAIN = "agent-plain";
const clone = (value) => structuredClone(value);
const active = (run) => run && ["running", "waiting"].includes(run.status);
const fail = (code) => { throw Object.assign(new Error(code), { domain: code }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OPEN_STATES = ["queued", "working", "input_required", "ready_for_review"];

// tools/wait.ts reasonFor: why wait_for_my_tasks lists a task (null: it does not).
export function taskReason(task, prompt) {
  if (task.state === "done" || task.state === "failed") return "closed";
  if (task.state === "cancelled") return "stop";
  if (prompt) {
    const body = prompt.body ?? {};
    if (body.signal === "stop") return "stop";
    if (body.handover === true) return "handover";
    if (body.approval_id !== undefined || body.decision !== undefined) return task.active_run_id ? "approval_decided" : "handover";
    if (body.signal === "feedback" || body.signal === "continue") return "feedback";
    if (body.signal === "start" && task.state === "queued") return "queued";
  }
  if (task.state === "input_required" && !task.active_run_id) return "handover";
  if (task.brief_stale === true) return "brief";
  if (task.state === "queued") return "queued";
  return null;
}

export function createStubWorld() {
  const tasks = [], runs = [], activities = [], approvals = [], external = [], artifacts = [];
  const pages = new Map(), receipts = new Map(), counts = new Map(), scripts = new Map(), losses = new Map(), kills = new Map();
  const dead = new Set(), calls = [], cursors = [];
  let nextBlock = 0;
  const taskFor = (id) => tasks.find((t) => t.id === id) ?? fail("not_found");
  const runFor = (id, agent) => runs.find((r) => r.id === id && r.agent_id === agent) ?? fail("forbidden");
  const rows = (table, task) => table.filter((r) => r.task_id === task);
  const activity = (task, run, type, body, author = run?.agent_id ?? "human", extra = {}) => {
    const row = { id: `act-${activities.length + 1}`, task_id: task.id, run_id: run?.id ?? null,
      seq: rows(activities, task.id).length + 1, type, body: clone(body), author_type: author === "human" ? "human" : "agent",
      author_id: author, ephemeral: false, created_at: new Date().toISOString(), ...extra };
    activities.push(row);
    return row;
  };
  // private.detach_task_links and private.task_waits_on_human (0019).
  const detach = (run) => {
    for (const a of approvals) if (a.run_id === run.id && ["pending", "decided"].includes(a.status)) a.run_id = null;
    for (const op of external) if (op.run_id === run.id && ["pending", "unknown"].includes(op.status)) op.run_id = null;
  };
  const waiting = (task) => rows(approvals, task.id).some((a) => a.status === "pending");
  const release = (task, run, status) => {
    if (run) { detach(run); run.status = status; }
    task.active_run_id = null;
    task.state = waiting(task) ? "input_required" : "queued";
  };
  const receiptKey = (agent, tool, key) => JSON.stringify([agent, tool, key]);
  // private.resume_context: receipts belong to the checkpoint's actor, not the claimant; "from" is the last run that
  // ended, and a checkpoint from an earlier run is stale (its pending writes without a receipt are unknown).
  const resumeFor = (task, newRun) => {
    const cp = rows(activities, task.id).filter((a) => a.type === "checkpoint").at(-1);
    const cpRun = runs.find((r) => r.id === cp?.run_id);
    const from = rows(runs, task.id).filter((r) => r.id !== newRun.id && !active(r)).at(-1) ?? cpRun;
    const stale = !!cp && from?.id !== cp.run_id;
    const readable = cp?.body.v === 1;
    const pending = readable ? (cp.body.ops?.pending ?? []).map((op) => {
      const receipt = receipts.get(receiptKey(cpRun?.agent_id, op.tool, op.key));
      return { ...clone(op), status: receipt ? "confirmed" : stale ? "unknown" : "not_executed", ...(receipt ? { result: clone(receipt) } : {}) };
    }) : [];
    const blocks = new Map();
    for (const op of [...(readable ? cp.body.ops?.confirmed ?? [] : []), ...pending]) {
      for (const id of [...(op.block_ids ?? []), ...(op.result?.block_ids ?? [])]) {
        const block = (pages.get(op.page_id) ?? []).find((b) => b.id === id);
        blocks.set(`${op.page_id}:${id}`, { page_id: op.page_id, block_id: id, exists: !!block,
          rev: block?.rev ?? null, last_by: block?.attr.by ?? null,
          changed_by_other: !!block && !rows(runs, task.id).some((r) => r.id === block.attr.runId) });
      }
    }
    return { checkpoint: cp ? { seq: cp.seq, readable, version: cp.body.v, body: clone(cp.body), run_id: cp.run_id, harness: cp.body.harness, stale } : null,
      from: from ? { run_id: from.id, agent_id: from.agent_id, harness: from.harness, status: from.status,
        delivered: rows(activities, task.id).some((a) => a.run_id === from.id && a.type === "response" && a.body.submit === true) } : null,
      pending_ops: pending, blocks: [...blocks.values()], approvals: clone(rows(approvals, task.id).filter((a) => ["pending", "decided"].includes(a.status))),
      external_ops_open: clone(rows(external, task.id).filter((op) => ["pending", "unknown"].includes(op.status))),
      summary: cp ? `Continuing from checkpoint #${cp.seq} by ${from?.harness}.` : "No checkpoint yet." };
  };
  // claim_task records a handover only when the previous run ended with hand_over or a person released it after it started.
  const handedOver = (task, from) => {
    if (!from) return false;
    const list = rows(activities, task.id), start = list.find((a) => a.run_id === from.run_id)?.seq ?? Infinity;
    return list.some((a) => (a.type === "checkpoint" && a.run_id === from.run_id && a.body.handover === true)
      || (a.type === "prompt" && a.body.handover === true && a.seq > start));
  };
  // wait_for_my_tasks: a cursor is the activity count and each task's state when it was issued.
  const taskView = (t) => JSON.stringify([t.state, t.active_run_id, t.delegate_agent_id]);
  const myTask = (t, reason, prompts) => ({ task_id: t.id, title: t.title, state: t.state, waiting_on: t.state === "input_required" ? "human" : null,
    active_run_id: t.active_run_id, pending_prompts: prompts, reason });
  const requestApproval = (task, run, args) => {
    let a = rows(approvals, task.id).find((a) => a.status === "pending" && a.action === args.action && same(a.params, args.params));
    if (!a) {
      a = { id: `ap-${approvals.length + 1}`, task_id: task.id, run_id: run.id, action: args.action, params: clone(args.params ?? {}), status: "pending" };
      approvals.push(a);
      activity(task, run, "elicitation", { approval_id: a.id, action: a.action });
    }
    run.status = "waiting"; task.state = "input_required";
    return { approval_id: a.id, status: "pending" };
  };

  function apply(agent, name, args) {
    if (name === "wait_for_my_tasks") {
      // Without a cursor: the open tasks by their state alone. With one: the tasks that changed or got a prompt since,
      // by their latest new prompt. The cursor always moves past what it saw, as on the server.
      const mine = tasks.filter((t) => t.delegate_agent_id === agent);
      const since = args.after === undefined ? null : cursors[Number(args.after)] ?? fail("invalid_input");
      const listed = mine.flatMap((t) => {
        if (!since) return OPEN_STATES.includes(t.state) ? [myTask(t, taskReason(t, undefined), 0)] : [];
        const prompts = activities.slice(since.activities).filter((a) => a.task_id === t.id && a.type === "prompt");
        if (since.views.get(t.id) === taskView(t) && !prompts.length) return [];
        return [myTask(t, taskReason(t, prompts.at(-1)), prompts.length)];
      }).filter((t) => t.reason);
      cursors.push({ activities: activities.length, views: new Map(tasks.map((t) => [t.id, taskView(t)])) });
      return { changed: listed.length > 0, next_cursor: String(cursors.length - 1), tasks: listed };
    }
    if (name === "claim_task") {
      if (args.resume && agent === PLAIN) fail("resume_unsupported");
      const task = taskFor(args.task_id);
      if (task.delegate_agent_id !== agent) fail("task_unavailable");
      if (task.active_run_id) fail("run_active");
      if (!["queued", "input_required", "ready_for_review"].includes(task.state)) fail("task_unavailable");
      const run = { id: `run-${runs.length + 1}`, task_id: task.id, agent_id: agent, harness: args.harness, status: "running" };
      runs.push(run); task.active_run_id = run.id; task.state = "working";
      for (const a of rows(approvals, task.id)) if (["pending", "decided"].includes(a.status)) a.run_id = run.id;
      for (const op of rows(external, task.id)) if (["pending", "unknown"].includes(op.status)) op.run_id = run.id;
      if (waiting(task)) { run.status = "waiting"; task.state = "input_required"; }
      activity(task, run, "action", { op: "claim" });
      const resume = args.resume ? resumeFor(task, run) : null;
      if (handedOver(task, resume?.from)) activity(task, run, "handover", { from_harness: resume.from.harness, to_harness: args.harness,
        from_run_id: resume.from.run_id, from_agent_id: resume.from.agent_id, to_run_id: run.id, to_agent_id: agent,
        checkpoint_seq: resume.checkpoint?.seq ?? null, counts: {}, summary: resume.summary });
      return { task_id: task.id, run_id: run.id, row_page_id: task.row_page_id, brief: task.brief,
        recent_activities: clone(rows(activities, task.id).filter((a) => !a.ephemeral).slice(-20)), ...(args.resume ? { resume } : {}) };
    }
    if (name === "read_page") return { page_id: args.page_id, markdown: (pages.get(args.page_id) ?? []).map((b) => b.text).join("\n\n"), blocks: clone(pages.get(args.page_id) ?? []) };
    if (name === "get_task") {
      const task = taskFor(args.task_id);
      return { task: clone(task), brief: clone(task.brief), approvals_pending: clone(rows(approvals, task.id).filter((a) => a.status === "pending")), activities: clone(rows(activities, task.id)) };
    }
    if (name === "wait_for_task") {
      const task = taskFor(args.task_id);
      const news = rows(activities, task.id).filter((a) => args.after_seq === undefined || a.seq > args.after_seq);
      return { changed: !!news.length, next_seq: rows(activities, task.id).at(-1)?.seq ?? 0, task: { ...clone(task), subtasks: [] }, stop_requested: false,
        activities: news.map((a) => ({ seq: a.seq, type: a.type, author_type: a.author_type, author: a.author_id,
          excerpt: a.body.text ?? "", created_at: a.created_at, ...(a.body.signal ? { signal: a.body.signal } : {}) })) };
    }
    if (["append_blocks", "edit_page"].includes(name)) {
      const key = receiptKey(agent, name, args.idempotency_key);
      if (args.idempotency_key && receipts.has(key)) return clone(receipts.get(key));
      const run = runs.find((r) => r.agent_id === agent && active(r)) ?? fail("run_not_active");
      const task = taskFor(run.task_id), blocks = pages.get(args.page_id) ?? fail("not_found");
      let result, inverse;
      if (name === "append_blocks") {
        const added = (args.markdown ? [args.markdown] : (args.blocks ?? []).map((b) => (b.spans ?? []).join("")))
          .map((text) => ({ id: `blk-${++nextBlock}`, text, rev: 1, attr: { by: "agent", runId: run.id } }));
        blocks.push(...added); result = { block_ids: added.map((b) => b.id), revision: blocks.length };
        inverse = added.map((b) => ({ op: "delete_block", id: b.id }));
      } else {
        const b = blocks.find((b) => b.id === args.block_id) ?? fail("block_not_found");
        const occurrences = b.text.split(args.old_str).length - 1;
        if (args.rev !== undefined && args.rev !== b.rev && occurrences !== 1) fail("block_conflict");
        if (occurrences !== 1) fail(occurrences ? "old_str_not_unique" : "old_str_not_found");
        inverse = [{ op: "update_block", id: b.id, patch: { html: b.text } }];
        b.text = b.text.replace(args.old_str, args.new_str); b.rev++; b.attr = { by: "agent", runId: run.id };
        result = { block_id: b.id, rev: b.rev };
      }
      activity(task, run, "action", { op: name === "append_blocks" ? name : "edit_block", page_id: args.page_id }, agent, { inverse_ops: inverse });
      if (args.idempotency_key) receipts.set(key, clone(result));
      return result;
    }
    if (name === "finish_external_op") {
      const op = external.find((o) => o.op_id === args.op_id) ?? fail("not_found");
      const run = runFor(op.run_id, agent);
      op.status = args.status;
      activity(taskFor(run.task_id), run, "action", { op: "external", external_op_id: op.op_id, status: op.status });
      return {};
    }
    const run = runFor(args.run_id, agent), task = taskFor(run.task_id);
    if (name === "heartbeat") return { stop_requested: run.stop_requested_at != null, pending_prompts: [], brief_stale: false };
    if (["save_checkpoint", "hand_over"].includes(name)) {
      if (!args.idempotency_key) fail("invalid_input");
      const old = rows(activities, task.id).find((a) => a.idempotency_key === args.idempotency_key);
      if (old && (old.type !== "checkpoint" || old.run_id !== run.id || (name === "hand_over" && old.body.handover !== true))) fail("idempotency_conflict");
      if (old) return { activity_id: old.id, seq: old.seq, task_state: task.state, replayed: true };
      if (!active(run) || task.active_run_id !== run.id) fail("run_not_active");
      if (name === "hand_over" && run.stop_requested_at) fail("stop_requested");
      if (args.checkpoint?.v !== 1) fail("checkpoint_version_unsupported");
      if (!args.checkpoint.next_step || (name === "hand_over" && !args.checkpoint.handover_note)) fail("invalid_input");
      const a = activity(task, run, "checkpoint", { ...args.checkpoint, harness: run.harness, handover: name === "hand_over" }, agent,
        { ephemeral: name === "save_checkpoint", idempotency_key: args.idempotency_key });
      if (name === "hand_over") release(task, run, "completed");
      return { activity_id: a.id, seq: a.seq, task_state: task.state, replayed: false };
    }
    if (name === "request_approval") return requestApproval(task, run, args);
    if (name === "begin_external_op") {
      const existing = external.find((o) => o.run_id === run.id && same(o.params, args.params) && o.action === args.action && ["pending", "unknown"].includes(o.status));
      if (existing) return { op_id: existing.op_id, status: existing.status };
      const a = rows(approvals, task.id).find((a) => a.status === "decided" && a.decision === "approve" && a.action === args.action && same(a.params, args.params));
      if (!a) return { ...requestApproval(task, run, args), status: "approval_required" };
      a.status = "consumed";
      const op = { op_id: `op-${external.length + 1}`, task_id: task.id, run_id: run.id, action: args.action, params: clone(args.params), status: "pending", approval_id: a.id };
      external.push(op);
      return { op_id: op.op_id, status: op.status };
    }
    if (name === "add_artifact") {
      const a = { id: `art-${artifacts.length + 1}`, task_id: task.id, run_id: run.id, ...clone(args) }; artifacts.push(a);
      return { artifact_id: a.id, version: 1 };
    }
    if (name === "submit_for_review") {
      activity(task, run, "response", { text: args.summary, artifact_ids: clone(args.artifact_ids ?? []), submit: true });
      run.status = "completed"; task.active_run_id = null; task.state = "ready_for_review"; return { task_state: task.state };
    }
    if (name === "end_run" || name === "ack_stop") {
      run.status = name === "ack_stop" ? "cancelled" : args.status;
      for (const a of approvals) if (a.run_id === run.id && a.status === "pending") a.status = "cancelled";
      if (task.active_run_id === run.id) { task.active_run_id = null; task.state = name === "ack_stop" ? "cancelled" : "queued"; }
      return { task_state: task.state };
    }
    fail("unknown_tool");
  }

  return {
    client(agent) {
      const sessionCalls = [];
      return { calls: sessionCalls, async initialize() {}, async listTools() { return clone(WORLD_TOOLS); },
        async callTool(name, args) {
          const call = { agent, name, args: clone(args), outcome: "ok" }; calls.push(call); sessionCalls.push(call);
          if (dead.has(agent)) { call.outcome = "dead"; throw new McpError("Harness died"); }
          const key = `${agent}:${name}`, nth = (counts.get(key) ?? 0) + 1; counts.set(key, nth);
          let data;
          try { data = apply(agent, name, args); }
          catch (e) { if (!e.domain) throw e; call.outcome = `error:${e.domain}`; return { isError: true, data: { code: e.domain, message: e.message }, text: e.message }; }
          scripts.get(`${key}:${nth}`)?.();
          if (kills.get(key) === nth) dead.add(agent);
          const loss = losses.get(key);
          if (loss && nth > loss.skip && loss.count-- > 0) { call.outcome = "lost"; throw new McpError("Response lost"); }
          call.result = clone(data);
          return { isError: false, data: clone(data), text: JSON.stringify(data) };
        } };
    },
    human: {
      createTask({ title, delegate, done_when = [] }) {
        const id = `task-${tasks.length + 1}`, page = `row-${id}`;
        tasks.push({ id, title, delegate_agent_id: delegate, row_page_id: page, active_run_id: null, state: "queued", brief: { objective: title, done_when } });
        pages.set(page, []); return id;
      },
      decide(id, decision) {
        const a = approvals.find((a) => a.id === id) ?? fail("not_found"), task = taskFor(a.task_id);
        a.status = "decided"; a.decision = decision;
        const run = runs.find((r) => r.id === a.run_id);
        if (active(run)) { run.status = "running"; task.state = "working"; } else task.state = "queued";
        activity(task, null, "prompt", { signal: "feedback", approval_id: id, decision });
      },
      editBlock(page, id, text) { const b = pages.get(page).find((b) => b.id === id); b.text = text; b.rev++; b.attr = { by: "human" }; },
      feedback(id, text) { activity(taskFor(id), null, "prompt", { signal: "feedback", text }); },
      stop(id) {
        const task = taskFor(id), run = runs.find((r) => r.id === task.active_run_id);
        if (run) run.stop_requested_at = new Date().toISOString(); else task.state = "cancelled";
      },
      releaseForHandover(id, to, note = "") {
        const task = taskFor(id), run = runs.find((r) => r.id === task.active_run_id);
        if (run) run.stop_requested_at = new Date().toISOString();
        release(task, run, "cancelled"); if (to) task.delegate_agent_id = to;
        activity(task, null, "prompt", { signal: "continue", handover: true, text: note });
      },
      insertCheckpoint(id, body, harness) {
        const task = taskFor(id), run = { id: `run-${runs.length + 1}`, task_id: id, agent_id: task.delegate_agent_id, harness, status: "completed" };
        runs.push(run); activity(task, run, "checkpoint", { ...body, harness }, run.agent_id);
      },
    },
    faults: { loseResponses(agent, name, { skip = 0, count }) { losses.set(`${agent}:${name}`, { skip, count }); }, killAfter(agent, name, nth) { kills.set(`${agent}:${name}`, nth); } },
    script(agent, name, nth, action) { scripts.set(`${agent}:${name}:${nth}`, action); },
    task: (id) => clone(taskFor(id)), runs: (id) => clone(rows(runs, id)), approvals: (id) => clone(rows(approvals, id)),
    activities: (id) => clone(rows(activities, id)), externalOps: (id) => clone(rows(external, id)), blocks: (id) => clone(pages.get(id) ?? []),
    calls: (agent) => clone(calls.filter((c) => c.agent === agent)),
  };
}
