#!/usr/bin/env node
// Waits until a task changes, prints one line and exits. Meant for Claude
// Code's background Bash or Monitor tool, which wake the session when the
// process ends or prints a line:
//
//   node connect/claude-code/wait.mjs --task <task_id> [--max-min <minutes>]
//
// Env: WORKSPACE_MCP_URL, WORKSPACE_AGENT_PAT, optional WORKSPACE_AGENT_TOKEN_URL.
// Exit codes: 0 the task changed, 2 usage or configuration error, 3 time limit reached.

import { pathToFileURL } from "node:url";
import { createRemote } from "../../bridge/remote.mjs";

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ task: string, maxMin: number }} */
  const out = { task: "", maxMin: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") out.task = argv[++i] ?? "";
    else if (argv[i] === "--max-min") out.maxMin = Number(argv[++i]) || 0;
  }
  return out;
}

/**
 * @param {{ task_id?: string, state?: string, review_state?: string, waiting_on?: string | null }} task
 * @param {Array<{ type?: string, author?: string, excerpt?: string }>} activities
 */
export function describeChange(task, activities) {
  const last = activities[activities.length - 1];
  const parts = [`${task.task_id ?? "task"} changed: state ${task.state ?? "?"}`];
  if (task.review_state) parts.push(`review ${task.review_state}`);
  if (task.waiting_on) parts.push(`waiting on ${task.waiting_on}`);
  if (last) parts.push(`last activity ${last.type ?? "?"}${last.author ? ` by ${last.author}` : ""}${last.excerpt ? `: ${last.excerpt}` : ""}`);
  return parts.join(", ").replace(/\s+/g, " ").slice(0, 400);
}

/**
 * @param {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   write?: (line: string) => void,
 *   log?: (message: string) => void,
 * }} options
 */
export async function runWait({ argv, env, fetchImpl, now = Date.now, sleep, write = console.log, log = () => {} }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { task, maxMin } = parseArgs(argv);
  const mcpUrl = (env.WORKSPACE_MCP_URL ?? "").trim();
  const pat = (env.WORKSPACE_AGENT_PAT ?? "").trim();
  if (!task || !mcpUrl || !pat) {
    log("usage: node connect/claude-code/wait.mjs --task <task_id> [--max-min <minutes>] (needs WORKSPACE_MCP_URL and WORKSPACE_AGENT_PAT)");
    return 2;
  }
  const remote = createRemote({
    mcpUrl,
    pat,
    tokenUrl: (env.WORKSPACE_AGENT_TOKEN_URL ?? "").trim() || undefined,
    fetch: fetchImpl,
    now,
    log,
    clientInfo: { name: "colabora-wait", version: "0.1.0" },
  });
  const deadline = maxMin > 0 ? now() + maxMin * 60_000 : Infinity;
  /** @type {number | undefined} */ let afterSeq;
  let failures = 0;
  while (now() < deadline) {
    /** @type {Record<string, unknown>} */
    const args = { task_id: task, timeout_s: afterSeq === undefined ? 0 : 120 };
    if (afterSeq !== undefined) args.after_seq = afterSeq;
    try {
      const result = await remote.callTool("wait_for_task", args);
      failures = 0;
      if (afterSeq !== undefined && result?.changed) {
        write(describeChange(result.task ?? { task_id: task }, Array.isArray(result.activities) ? result.activities : []));
        return 0;
      }
      if (typeof result?.next_seq === "number") afterSeq = result.next_seq;
      else if (afterSeq === undefined) afterSeq = 0;
    } catch (error) {
      failures++;
      log(`wait_for_task failed: ${error instanceof Error ? error.message : String(error)}`);
      await pause(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)));
    }
  }
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runWait({
    argv: process.argv.slice(2),
    env: process.env,
    log: (message) => process.stderr.write(`[colabora-wait] ${message}\n`),
  });
  process.exit(code);
}
