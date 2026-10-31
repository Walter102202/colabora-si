#!/usr/bin/env node
// Codex Stop hook: when Codex ends its turn, wait (outside the model) until
// one of the agent's tasks needs it again, then continue the session with a
// short prompt. It keeps waiting after a task closes or is stopped. Without
// new work it exits 0 with no output at the deadline or after five consecutive
// failures; it never continues because of the clock.
//
// Input (stdin): the Stop hook payload { session_id, cwd, turn_id, stop_hook_active, … }.
// Output (stdout): {"decision":"block","reason":"…"} to continue, or nothing.

import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileState } from "./state.mjs";
import { buildReason, isLeadNotice, MAX_REASON_CHARS } from "../../agent/taskEvent.mjs";
import { createRemote } from "../../bridge/remote.mjs";

export { buildReason, isLeadNotice, MAX_REASON_CHARS };

export const DEFAULT_WAIT_MIN = 25;
export const CONTINUE_REASONS = new Set(["feedback", "queued", "brief", "handover"]);
export const FINISHED_STATES = new Set(["done", "cancelled", "failed"]);

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : "");

/**
 * Pulls a short excerpt of the latest feedback out of a `get_task` result.
 * @param {any} detail
 */
export function feedbackExcerpt(detail) {
  const activities = Array.isArray(detail?.activities) ? [...detail.activities] : [];
  activities.sort((a, b) => (Number(b?.seq) || 0) - (Number(a?.seq) || 0));
  const prompt = activities.find((a) => a?.type === "prompt" && (a?.body?.signal ?? a?.signal) !== "stop");
  if (!prompt) return "";
  const body = prompt.body ?? {};
  const findings = Array.isArray(body.findings)
    ? body.findings.map((/** @type {any} */ f) => [text(f?.criterion_id), text(f?.status), text(f?.note)].filter(Boolean).join(" "))
    : [];
  return [text(body.text) || text(prompt.excerpt), ...findings].filter(Boolean).join("; ").replace(/\s+/g, " ").trim();
}

/**
 * Builds the continuation prompt (at most MAX_REASON_CHARS characters).
 * @param {{ task_id: string, title?: string, reason?: string, brief_version?: number, waiting_on?: string | null }} task
 * @param {string} excerpt
 */
/**
 * @param {{
 *   input: { stop_hook_active?: boolean, [key: string]: unknown },
 *   env: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   state?: { load: () => { delivered?: Record<string, string> }, save: (state: { delivered: Record<string, string> }) => void },
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<{ exitCode: number, output?: string, acknowledge?: () => Promise<void> }>}
 */
export async function runStopHook({ input, env, fetchImpl, state, now = Date.now, sleep, log = () => {} }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const mcpUrl = (env.WORKSPACE_MCP_URL ?? "").trim();
  const pat = (env.WORKSPACE_AGENT_PAT ?? "").trim();
  if (!mcpUrl || !pat) {
    log("WORKSPACE_MCP_URL or WORKSPACE_AGENT_PAT is not set; not waiting");
    return { exitCode: 0 };
  }
  const waitMin = Number(env.HOOK_WAIT_MIN) > 0 ? Number(env.HOOK_WAIT_MIN) : DEFAULT_WAIT_MIN;
  const deadline = now() + waitMin * 60_000;
  const remote = createRemote({
    mcpUrl,
    pat,
    tokenUrl: (env.WORKSPACE_AGENT_TOKEN_URL ?? "").trim() || undefined,
    fetch: fetchImpl,
    now,
    log,
    clientInfo: { name: "colabora-codex-stop-hook", version: "0.1.0" },
  });
  let saved = {};
  try { saved = state?.load() ?? {}; } catch (error) { log(`state load failed: ${error.message}`); }
  const delivered = new Map(Object.entries(saved.delivered ?? {}));
  const ackRetry = new Map();
  const persist = () => {
    try { state?.save({ delivered: Object.fromEntries(delivered) }); }
    catch (error) { log(`state save failed; retaining acknowledgement in memory: ${error.message}`); }
  };
  const acknowledge = async () => {
    for (const [id, after] of delivered) {
      if ((ackRetry.get(id)?.nextAt ?? 0) > now()) continue;
      try {
        await remote.callTool("wait_for_my_tasks", { after, timeout_s: 0 });
        delivered.delete(id); ackRetry.delete(id); persist();
      } catch (error) {
        const failures = (ackRetry.get(id)?.failures ?? 0) + 1;
        ackRetry.set(id, { failures, nextAt: now() + Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5)) });
        log(`notice acknowledgement failed; retry scheduled: ${error.message}`);
      }
    }
  };

  // In a continuation, old feedback/brief changes were already handled.
  // Queued tasks and handovers in the first snapshot still need a session.
  let baseline = input?.stop_hook_active === true;
  /** @type {string | undefined} */ let cursor;
  let first = true;
  let failures = 0;

  for (;;) {
    await acknowledge();
    const remainingS = Math.floor((deadline - now()) / 1000);
    if (!first && remainingS <= 0) return { exitCode: 0 };
    /** @type {Record<string, unknown>} */
    const args = first ? { timeout_s: 0 } : { timeout_s: Math.max(1, Math.min(120, remainingS)) };
    if (cursor) args.after = cursor;

    /** @type {any} */ let result;
    try {
      result = await remote.callTool("wait_for_my_tasks", args);
      failures = 0;
    } catch (error) {
      failures++;
      log(`wait_for_my_tasks failed: ${error instanceof Error ? error.message : String(error)}`);
      if (failures >= 5 || now() >= deadline) return { exitCode: 0 };
      await pause(Math.min(30_000, 2000 * 2 ** failures));
      continue;
    }
    first = false;
    if (typeof result?.next_cursor === "string") cursor = result.next_cursor;
    const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
    const initial = baseline;
    baseline = false;

    // A handover that waits on a person is still work for a session: it claims the task and waits in its run. Any other
    // task that waits on a person (a blocked or escalated review) is neither work nor a reason to stop: keep waiting for
    // the person's answer, which requeues it.
    const next = tasks.find((/** @type {any} */ t) =>
      t?.task_id && !(initial && (t.reason === "feedback" || t.reason === "brief"))
      && CONTINUE_REASONS.has(t.reason) && !FINISHED_STATES.has(t.state) && (t.reason === "handover" || t.waiting_on !== "human"));
    const notices = tasks.filter(task => isLeadNotice(task) && !delivered.has(task.notice.event_id));
    const notice = notices.find(task => typeof task.notice.ack_cursor === "string");
    if (notice) return {
      exitCode: 0, output: JSON.stringify({ decision: "block", reason: buildReason(notice, "") }),
      acknowledge: async () => {
        delivered.set(notice.notice.event_id, notice.notice.ack_cursor); persist();
        await acknowledge();
      },
    };
    if (next || notices.length) {
      let excerpt = "";
      if (next?.reason === "feedback") {
        try { excerpt = feedbackExcerpt(await remote.callTool("get_task", { task_id: next.task_id, activities_limit: 10 })); }
        catch (error) { log(`get_task failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { exitCode: 0, output: JSON.stringify({ decision: "block", reason: [...(next ? [buildReason(next, excerpt)] : []), ...notices.map(task => buildReason(task, ""))].join("\n\n") }) };
    }
    if (delivered.size) {
      const current = now();
      if (current >= deadline) return { exitCode: 0 };
      const due = Math.min(...[...delivered.keys()].map(id => ackRetry.get(id)?.nextAt ?? current));
      await pause(Math.min(deadline - current, Math.max(1000, Math.min(30_000, due - current))));
    }
  }
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = await readStdin();
  /** @type {any} */ let input = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const session = String(input.session_id ?? process.env.CODEX_THREAD_ID ?? "");
  const statePath = process.env.WORKSPACE_HOOK_STATE || (/^[0-9a-f-]{36}$/i.test(session) ? join(homedir(), ".codex", `colabora-hook-${session}.json`) : null);
  const { exitCode, output, acknowledge } = await runStopHook({
    input,
    env: process.env,
    state: statePath ? fileState(statePath) : undefined,
    log: (message) => process.stderr.write(`[colabora-stop-hook] ${message}\n`),
  });
  if (output) {
    await new Promise((resolve, reject) => process.stdout.write(`${output}\n`, error => error ? reject(error) : resolve()));
    await acknowledge?.();
  }
  process.exit(exitCode);
}
