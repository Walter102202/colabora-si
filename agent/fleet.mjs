#!/usr/bin/env node
// Managed Trama: one always-on process with one agent listening for every workspace of this deployment.
// Without the project's secrets it refuses to start, so a fork never runs on someone else's model key.

import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readFleetConfig } from "./config.mjs";
import { createMcpClient } from "./mcpClient.mjs";
import { createModel } from "./model.mjs";
import { serveAgent } from "./serve.mjs";

export const LIST_EVERY_MS = 30_000;

/** @param {number} ms @param {AbortSignal} signal */
const rest = (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined);

/**
 * Keeps one `serve` running per listed agent: a new workspace joins on the next list, a removed agent stops, a failed one restarts.
 * @param {{
 *   listAgents: () => Promise<string[]>,
 *   serve: (agentId: string, signal: AbortSignal) => Promise<void>,
 *   signal: AbortSignal,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   log?: (msg: string) => void,
 * }} opts
 */
export async function runFleet({ listAgents, serve, signal, sleep = rest, log = () => {} }) {
  /** @type {Map<string, {stop: AbortController, done: Promise<void>}>} */
  const running = new Map();
  while (!signal.aborted) {
    try {
      const listed = new Set(await listAgents());
      for (const [id, agent] of running) if (!listed.has(id)) agent.stop.abort();
      for (const id of listed) {
        if (running.has(id)) continue;
        const stop = new AbortController();
        const done = serve(id, AbortSignal.any([signal, stop.signal]))
          .catch((/** @type {any} */ error) => log(`agent ${id} stopped: ${error?.message ?? error}`))
          .finally(() => running.delete(id));
        running.set(id, { stop, done });
      }
    } catch (error) {
      log(`listing agents failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(LIST_EVERY_MS, signal);
  }
  await Promise.allSettled([...running.values()].map((agent) => agent.done));
}

async function main() {
  /** @param {string} msg */
  const log = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
  const { runtimeUrl, secret, config } = readFleetConfig(process.env);
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());

  /** @param {Record<string, unknown>} body */
  async function runtime(body) {
    const res = await fetch(runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Runtime-Secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`trama-runtime ${body.action}: ${json.error ?? `HTTP ${res.status}`}`);
    return json;
  }

  const model = createModel({ baseUrl: config.modelBaseUrl, apiKey: config.modelApiKey, model: config.modelName });
  log(`trama started: model ${config.modelName}`);
  await runFleet({
    signal: controller.signal,
    log,
    listAgents: async () => (await runtime({ action: "agents" })).agents,
    serve(agentId, signal) {
      const mcp = createMcpClient({ url: config.mcpUrl, clientName: config.harness, signIn: async () => (await runtime({ action: "token", agent_id: agentId })).access_token });
      return serveAgent({ config, mcp, model, signal, log });
    },
  });
  log("stopped");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
