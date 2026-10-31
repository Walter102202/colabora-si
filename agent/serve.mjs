// One agent at work: its channel, its inbox and the loop. The CLI serves one agent, the managed runtime one per workspace.

import { createConsoleChannel } from "./channels/console.mjs";
import { createTelegramChannel } from "./channels/telegram.mjs";
import { createInbox } from "./inbox.mjs";
import { runAgent } from "./loop.mjs";
import { createVoiceClient } from "./voice.mjs";

/**
 * @param {{
 *   config: import("./config.mjs").AgentConfig,
 *   mcp: import("./mcpClient.mjs").McpClient,
 *   model: import("./model.mjs").Model,
 *   noticeState?: Parameters<typeof runAgent>[0]["noticeState"],
 *   signal: AbortSignal,
 *   log: (msg: string) => void,
 * }} opts
 */
export async function serveAgent({ config, mcp, model, noticeState, signal, log }) {
  let status = "waiting for tasks";
  const base = config.telegramBotToken
    ? createTelegramChannel({ token: config.telegramBotToken, ownerChatId: config.telegramOwnerChatId, log, transport: config.telegramTransport, channelRpc: async (name, args) => { const result = await mcp.callTool(name, args); if (result.isError) throw Object.assign(new Error("Channel request failed"), { code: result.data?.code }); return result.data; } })
    : createConsoleChannel();
  const channel = {
    appUrl: config.appUrl,
    reply: (/** @type {string} */ chatId, /** @type {string} */ text) => ("reply" in base ? base.reply(chatId, text) : Promise.resolve()),
    /** @param {import("./loop.mjs").ChannelEvent} event */
    notify(event) {
      status = event.kind === "claimed" ? `working on ${event.task_id}` : event.kind === "approval_pending" || event.kind === "input_requested" ? `waiting for a person on ${event.task_id}` : "waiting for tasks";
      return base.notify(event);
    },
  };
  const inbox = config.inbox && "reply" in base
    ? createInbox({
      call: mcp.callTool,
      transcribe: createVoiceClient({ url: config.voiceUrl, accessToken: mcp.accessToken, download: base.download, ffmpeg: config.ffmpegPath }),
      send: base.reply, typing: base.typing, appUrl: config.appUrl, timezone: config.timezone, log,
    })
    : null;
  void base.start({ signal, status: () => status, ...(inbox ? { onMessage: inbox.deliver } : {}) });

  await runAgent({
    mcp,
    model,
    noticeState,
    channel,
    harness: config.harness,
    displayName: config.displayName,
    reviewerAgentId: config.reviewerAgentId,
    resume: config.resume,
    modelVision: config.modelVision,
    modelPdf: config.modelPdf,
    prices: config.prices,
    appUrl: config.appUrl,
    maxTurns: config.maxTurns,
    signal,
    log,
  });
}
