#!/usr/bin/env node
// Muse starts hooks with a clean environment; credentials live outside the repo.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runStopHook } from "../codex/on-stop.mjs";
import { fileState } from "../codex/state.mjs";

export const CREDENTIAL_KEYS = ["WORKSPACE_MCP_URL", "WORKSPACE_AGENT_PAT", "WORKSPACE_AGENT_TOKEN_URL", "HOOK_WAIT_MIN", "WORKSPACE_HOOK_STATE"];
export const defaultCredentialsPath = (home = homedir()) => join(home, ".config", "muse", "colabora.env");

/** KEY=value lines, without shell expansion or evaluation. */
export function parseEnvFile(text) {
  const entries = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    entries.push([match[1], value]);
  }
  return Object.fromEntries(entries);
}

/** Supported process variables override file values, including when the file is unreadable. */
export function resolveCredentials({ env = {}, argv = [], home = homedir(), readFile = path => readFileSync(path, "utf8"), log = () => {} }) {
  let path = defaultCredentialsPath(home);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") { path = argv[i + 1]; break; }
    if (argv[i].startsWith("--env=")) { path = argv[i].slice(6); break; }
  }
  let file = {};
  try { file = parseEnvFile(readFile(path)); }
  catch { log("credentials file unavailable; using process environment only"); }
  return Object.fromEntries(CREDENTIAL_KEYS.flatMap(key => {
    const value = env[key] ?? file[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export function museStatePath(sessionId, home = homedir(), override) {
  if (override) return override;
  if (!sessionId.trim()) return null;
  const session = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return join(home, ".config", "muse", `colabora-hook-${session}.json`);
}

export const redact = (message, secrets) => secrets.reduce((m, secret) => secret ? m.split(secret).join("[redacted]") : m, String(message));

export async function runMuseStopHook({ input, env, argv, home, readFile, fetchImpl, now, sleep, log = () => {}, stateFor = fileState }) {
  const credentials = resolveCredentials({ env, argv, home, readFile, log });
  const secrets = [credentials.WORKSPACE_AGENT_PAT, credentials.WORKSPACE_AGENT_PAT?.trim()];
  const safeLog = message => log(redact(message, secrets));
  if (!credentials.WORKSPACE_MCP_URL || !credentials.WORKSPACE_AGENT_PAT) {
    safeLog("no credentials; not waiting");
    return { exitCode: 0 };
  }
  const statePath = museStatePath(String(input?.session_id ?? ""), home, credentials.WORKSPACE_HOOK_STATE);
  return runStopHook({
    input: { stop_hook_active: input?.stop_hook_active === true },
    env: credentials, fetchImpl, now, sleep, log: safeLog,
    state: statePath ? stateFor(statePath) : undefined,
    clientInfo: { name: "colabora-muse-stop-hook", version: "0.1.0" },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const { exitCode, output, acknowledge } = await runMuseStopHook({
    input, env: process.env, argv: process.argv.slice(2),
    log: message => process.stderr.write(`[colabora-muse-stop-hook] ${message}\n`),
  });
  if (output) {
    await new Promise((resolve, reject) => process.stdout.write(`${output}\n`, error => error ? reject(error) : resolve()));
    await acknowledge?.();
  }
  process.exit(exitCode);
}
