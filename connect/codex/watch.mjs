#!/usr/bin/env node
// Codex watcher: carries task changes to the Codex session that worked on them,
// through `codex queue`. It runs outside Codex, so it holds no session open and
// has no time limit. It writes only to the session saved in the agent's last
// run of that task, or to WORKSPACE_CODEX_THREAD when the task has none yet.
// It never guesses a session.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRemote } from "../../bridge/remote.mjs";
import { CONTINUE_REASONS, FINISHED_STATES, isLeadNotice, buildReason, feedbackExcerpt } from "./on-stop.mjs";
import { fileState } from "./state.mjs";
export { fileState } from "./state.mjs";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SESSION_HINT = " When you call claim_task, pass external_session_id with the value of the CODEX_THREAD_ID environment variable.";

/** The session to write to, or null. A malformed session id is never replaced by the fallback. */
export function targetThread(task, fallback) {
  const session = typeof task?.session_id === "string" ? task.session_id.trim() : "";
  if (session) return THREAD_ID.test(session) ? session : null;
  const home = (fallback ?? "").trim();
  return THREAD_ID.test(home) ? home : null;
}

/** The CLI: explicit path, then the newest Codex Desktop build, then PATH. */
export function findCodex(env, fs = { existsSync, readdirSync, statSync }) {
  const explicit = (env.WORKSPACE_CODEX_BIN ?? "").trim();
  if (explicit) return explicit;
  const base = join(env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (!env.LOCALAPPDATA || !fs.existsSync(base)) return "codex";
  const builds = fs.readdirSync(base)
    .map((name) => join(base, name, "codex.exe"))
    .filter((path) => fs.existsSync(path))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return builds[0] ?? "codex";
}

export function codexQueue(bin, run = execFile, env = process.env) {
  return (thread, message) => new Promise((resolve, reject) => {
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !["WORKSPACE_AGENT_PAT", "WORKSPACE_AGENT_JWT"].includes(key.toUpperCase())));
    run(typeof bin === "function" ? bin() : bin, ["queue", "--thread", thread, "--message", message], { timeout: 60_000, windowsHide: true, env: childEnv },
      (error) => (error ? reject(error) : resolve()));
  });
}

const eligible = (task) => Boolean(task?.task_id) && (isLeadNotice(task) || (CONTINUE_REASONS.has(task.reason) && !FINISHED_STATES.has(task.state)
  && (task.reason === "handover" || task.waiting_on !== "human")));

export async function runWatcher({ env, queue, state, fetchImpl, sleep, signal, now = Date.now, log = () => {} }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const mcpUrl = (env.WORKSPACE_MCP_URL ?? "").trim();
  const pat = (env.WORKSPACE_AGENT_PAT ?? "").trim();
  if (!mcpUrl || !pat) {
    log("WORKSPACE_MCP_URL or WORKSPACE_AGENT_PAT is not set; not watching");
    return;
  }
  const remote = createRemote({
    mcpUrl,
    pat,
    tokenUrl: (env.WORKSPACE_AGENT_TOKEN_URL ?? "").trim() || undefined,
    fetch: fetchImpl,
    log,
    clientInfo: { name: "colabora-codex-watch", version: "0.1.0" },
  });
  let loaded = {};
  try { loaded = state.load() ?? {}; } catch (error) { log(`state load failed: ${error instanceof Error ? error.message : String(error)}`); }
  let cursor = loaded.cursor;
  const sent = new Map(Object.entries(loaded.sent ?? {}).map(([id, keys]) => [id, new Set(Array.isArray(keys) ? keys : [keys])]));
  const pending = new Map(Object.entries(loaded.pending ?? {}).filter(([, entry]) => entry?.task?.task_id).map(([id, entry]) =>
    [id, { ...entry, failures: 0, quarantined: false, nextAttemptAt: 0 }]));
  const persist = () => {
    try { state.save({ cursor, sent: Object.fromEntries([...sent].map(([id, keys]) => [id, [...keys]])), pending: Object.fromEntries(pending) }); }
    catch (error) { log(`state save failed; retaining progress in memory: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const identity = (task) => JSON.stringify([task.reason, task.brief_version, task.session_id, task.notice?.event_id]);
  let failures = 0;
  while (!signal?.aborted) {
    let result;
    try {
      // A pending retry must not sit behind a two-minute long poll.
      const retryingNow = [...pending.values()].some(entry => !entry.awaitingDestination && !entry.quarantined);
      const timeout = retryingNow ? 0 : cursor ? 120 : 0;
      result = await remote.callTool("wait_for_my_tasks", { timeout_s: timeout, ...(cursor ? { after: cursor } : {}) });
      failures = 0;
    } catch (error) {
      failures++;
      log(`wait_for_my_tasks failed: ${error instanceof Error ? error.message : String(error)}`);
      await pause(Math.min(60_000, 2000 * 2 ** failures));
      continue;
    }
    const details = new Map();
    for (const task of Array.isArray(result?.tasks) ? result.tasks : []) {
      if (!task?.task_id) continue;
      if (!eligible(task)) {
        if (FINISHED_STATES.has(task.state) || task.reason === "stop" || task.waiting_on === "human") pending.delete(task.task_id);
        continue;
      }
      const pendingId = task.notice?.event_id ? `${task.task_id}:${task.notice.event_id}` : task.task_id;
      const previous = pending.get(pendingId);
      let newPrompt = false;
      if (previous?.failures && previous.promptSeq !== undefined) {
        try {
          const detail = await remote.callTool("get_task", { task_id: task.task_id, activities_limit: 10 });
          details.set(pendingId, detail);
          const prompts = (Array.isArray(detail?.activities) ? detail.activities : []).filter(a => a?.type === "prompt");
          newPrompt = Math.max(0, ...prompts.map(a => Number(a.seq) || 0)) > previous.promptSeq;
        } catch { /* A failing read keeps the existing retry schedule. */ }
      }
      pending.set(pendingId, previous && !newPrompt && identity(previous.task) === identity(task)
        ? { ...previous, task } : { task, failures: 0, quarantined: false, nextAttemptAt: 0 });
    }
    for (const [id, entry] of pending) {
      if (entry.nextAttemptAt > now()) continue;
      const task = entry.task;
      const thread = targetThread(task, env.WORKSPACE_CODEX_THREAD);
      if (!thread) {
        if (!entry.awaitingDestination) log(`no session for task ${id}; notice retained until a destination exists`);
        entry.awaitingDestination = true;
        entry.nextAttemptAt = now() + 30_000;
        continue;
      }
      entry.awaitingDestination = false;
      try {
        const detail = details.get(id) ?? await remote.callTool("get_task", { task_id: task.task_id, activities_limit: 10 });
        if (!isLeadNotice(task) && FINISHED_STATES.has(detail?.task?.state)) { pending.delete(id); continue; }
        const prompts = (Array.isArray(detail?.activities) ? detail.activities : []).filter((a) => a?.type === "prompt");
        const promptSeq = Math.max(0, ...prompts.map((a) => Number(a.seq) || 0));
        entry.promptSeq = promptSeq;
        const key = isLeadNotice(task) ? `${thread}|notice|${task.notice.event_id}` : [thread, task.reason, task.brief_version, promptSeq].join("|");
        if (!sent.get(id)?.has(key)) {
          const excerpt = task.reason === "feedback" ? feedbackExcerpt(detail) : "";
          await queue(thread, `${buildReason(task, excerpt)}${SESSION_HINT}`);
          const keys = sent.get(id) ?? new Set();
          keys.add(key);
          sent.set(id, keys);
          log(`task ${id} (${task.reason}) sent to ${thread}`);
        }
        if (typeof task.notice?.ack_cursor === "string") {
          // Keep the sent identity and pending ack durable before any network acknowledgement.
          persist();
          await remote.callTool("wait_for_my_tasks", { after: task.notice.ack_cursor, timeout_s: 0 });
        }
        pending.delete(id);
        // Save acknowledgement before advancing the cursor. A later poll/save error cannot forget a successful send.
        persist();
      } catch (error) {
        entry.failures++;
        entry.quarantined = entry.failures >= 5;
        entry.nextAttemptAt = now() + (entry.quarantined ? 300_000 : Math.min(60_000, 2000 * 2 ** (entry.failures - 1)));
        entry.lastError = (error instanceof Error ? error.message : String(error)).replaceAll(pat, "[redacted]").slice(0, 500);
        log(`task ${id}: ${entry.lastError}${entry.quarantined ? "; quarantined after 5 failures" : `; retry ${entry.failures} scheduled`}`);
      }
    }
    const retrying = [...pending.values()].some((entry) => entry.failures && !entry.quarantined);
    if (!retrying && typeof result?.next_cursor === "string") cursor = result.next_cursor;
    persist();
    if (pending.size && !signal?.aborted) {
      const due = [...pending.values()].filter((entry) => !entry.awaitingDestination).map((entry) => entry.nextAttemptAt);
      if (due.length) await pause(Math.max(1000, Math.min(60_000, Math.min(...due) - now())));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWatcher({
    env: process.env,
    queue: codexQueue(() => findCodex(process.env)),
    state: fileState((process.env.WORKSPACE_WATCH_STATE ?? "").trim() || join(homedir(), ".codex", "colabora-watch.json")),
    log: (message) => process.stderr.write(`[colabora-codex-watch] ${message}\n`),
  });
}
