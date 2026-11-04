#!/usr/bin/env node
// Muse starts hooks with a clean environment; credentials live outside the repo.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
