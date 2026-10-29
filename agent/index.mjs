#!/usr/bin/env node
// Reference agent CLI: `node agent/index.mjs --env agent/.env`.
// Waits for tasks delegated to this agent, works on them with the configured
// model and reports back to the workspace through its MCP server.

import { createConsoleChannel } from "./channels/console.mjs";
import { createTelegramChannel } from "./channels/telegram.mjs";
import { loadEnvFile, readConfig } from "./config.mjs";
import { runAgent } from "./loop.mjs";
import { createMcpClient } from "./mcpClient.mjs";
import { createModel } from "./model.mjs";

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const envPath = envIndex === -1 ? "agent/.env" : args[envIndex + 1];
if (!envPath || args.includes("--help")) {
  process.stdout.write("Usage: node agent/index.mjs --env <path to .env file>\n");
  process.exit(envPath ? 0 : 1);
}

/** @param {string} msg */
const log = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

const config = readConfig(await loadEnvFile(envPath));
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (controller.signal.aborted) process.exit(130);
    log("stopping after the current step (press Ctrl+C again to quit now)");
    controller.abort();
  });
}

const mcp = createMcpClient({ url: config.mcpUrl, pat: config.agentPat, tokenUrl: config.tokenUrl, clientName: config.harness });
const model = createModel({ baseUrl: config.modelBaseUrl, apiKey: config.modelApiKey, model: config.modelName });

let status = "waiting for tasks";
const base = config.telegramBotToken
  ? createTelegramChannel({ token: config.telegramBotToken, ownerChatId: config.telegramOwnerChatId, log })
  : createConsoleChannel();
const channel = {
  /** @param {import("./loop.mjs").ChannelEvent} event */
  notify(event) {
    status = event.kind === "claimed" ? `working on ${event.task_id}` : event.kind === "approval_pending" || event.kind === "input_requested" ? `waiting for a person on ${event.task_id}` : "waiting for tasks";
    return base.notify(event);
  },
};
void base.start({ signal: controller.signal, status: () => status });

log(`${config.harness} started: model ${config.modelName}, workspace ${new URL(config.mcpUrl).host}`);
await runAgent({
  mcp,
  model,
  channel,
  harness: config.harness,
  reviewerAgentId: config.reviewerAgentId,
  resume: config.resume,
  prices: config.prices,
  appUrl: config.appUrl,
  maxTurns: config.maxTurns,
  signal: controller.signal,
  log,
});
log("stopped");
process.exit(0);
