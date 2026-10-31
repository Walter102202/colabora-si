#!/usr/bin/env node
// Codex watcher: carries task changes to the Codex session that worked on them,
// through `codex queue`. It runs outside Codex, so it holds no session open and
// has no time limit. It writes only to the session saved in the agent's last
// run of that task, or to WORKSPACE_CODEX_THREAD when the task has none yet.
// It never guesses a session.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRemote } from "../../bridge/remote.mjs";
import { CONTINUE_REASONS, FINISHED_STATES, buildReason, feedbackExcerpt } from "./on-stop.mjs";

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

export function codexQueue(bin, run = execFile) {
  return (thread, message) => new Promise((resolve, reject) => {
    run(bin, ["queue", "--thread", thread, "--message", message], { timeout: 60_000, windowsHide: true },
      (error) => (error ? reject(error) : resolve()));
  });
}

export function fileState(path) {
  return {
    load() {
      try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    },
  };
}

const eligible = (task) => Boolean(task?.task_id) && CONTINUE_REASONS.has(task.reason) && !FINISHED_STATES.has(task.state)
  && (task.reason === "handover" || task.waiting_on !== "human");

export async function runWatcher({ env, queue, state, fetchImpl, sleep, signal, log = () => {} }) {
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
  let cursor = state.load().cursor;
  const sent = new Map();
  let failures = 0;
  while (!signal?.aborted) {
    let result;
    try {
      result = await remote.callTool("wait_for_my_tasks", cursor ? { timeout_s: 120, after: cursor } : { timeout_s: 0 });
      failures = 0;
    } catch (error) {
      failures++;
      log(`wait_for_my_tasks failed: ${error instanceof Error ? error.message : String(error)}`);
      await pause(Math.min(60_000, 2000 * 2 ** failures));
      continue;
    }
    let retry = false;
    for (const task of (Array.isArray(result?.tasks) ? result.tasks : []).filter(eligible)) {
      const thread = targetThread(task, env.WORKSPACE_CODEX_THREAD);
      if (!thread) { log(`no session for task ${task.task_id}; not sending`); continue; }
      let detail;
      try { detail = await remote.callTool("get_task", { task_id: task.task_id, activities_limit: 10 }); }
      catch (error) {
        retry = true;
        log(`get_task failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      // Snapshot and cursor answers count prompts differently. Identify the prompt itself,
      // so a later review round in the same session still delivers even with the same count.
      const prompts = (Array.isArray(detail?.activities) ? detail.activities : []).filter((a) => a?.type === "prompt");
      const promptSeq = Math.max(0, ...prompts.map((a) => Number(a.seq) || 0));
      const key = [thread, task.reason, task.brief_version, promptSeq].join("|");
      if (sent.get(task.task_id) === key) continue;
      const excerpt = task.reason === "feedback" ? feedbackExcerpt(detail) : "";
      try {
        await queue(thread, `${buildReason(task, excerpt)}${SESSION_HINT}`);
        sent.set(task.task_id, key);
        log(`task ${task.task_id} (${task.reason}) sent to ${thread}`);
      } catch (error) {
        retry = true;
        log(`codex queue failed for task ${task.task_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (retry) { await pause(5000); continue; }
    if (typeof result?.next_cursor === "string") {
      cursor = result.next_cursor;
      state.save({ cursor });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWatcher({
    env: process.env,
    queue: codexQueue(findCodex(process.env)),
    state: fileState((process.env.WORKSPACE_WATCH_STATE ?? "").trim() || join(homedir(), ".codex", "colabora-watch.json")),
    log: (message) => process.stderr.write(`[colabora-codex-watch] ${message}\n`),
  });
}
