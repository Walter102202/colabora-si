// Configuration of the reference agent: a dotenv parser and the env contract.
// No dependencies; runs on Node 22.

import { readFile } from "node:fs/promises";

/**
 * @typedef {object} AgentConfig
 * @property {string} modelBaseUrl      OpenAI-compatible base URL (POST {modelBaseUrl}/chat/completions)
 * @property {string} modelApiKey       bearer key for the model endpoint ("" for local endpoints)
 * @property {string} modelName         model id sent in every request
 * @property {{input: number, output: number}} prices  USD per million tokens
 * @property {string} mcpUrl            remote MCP endpoint of the workspace
 * @property {string} agentPat          personal access token of this agent (agt_...)
 * @property {string} tokenUrl          PAT -> JWT exchange endpoint
 * @property {string} displayName       optional public agent identity
 * @property {string} harness           harness name reported on claim_task
 * @property {boolean} resume          resume from checkpoints when the server supports it
 * @property {boolean} modelVision     the model accepts image input
 * @property {boolean} modelPdf        the model accepts PDF input
 * @property {string} reviewerAgentId   reviewer instance delegated by the Lead ("" disables the review protocol)
 * @property {string} appUrl            public app URL for deep links ("" disables links)
 * @property {string} telegramBotToken  "" selects the console channel
 * @property {"polling"|"webhook"} telegramTransport
 * @property {string} telegramOwnerChatId
 * @property {number} maxTurns          model turns per run before giving up
 * @property {boolean} inbox           the platform agent reads what its owner sends on Telegram
 * @property {string} voiceUrl          voice-transcribe endpoint
 * @property {string} timezone          IANA zone for the dates of notes ("" means UTC)
 * @property {string} ffmpegPath        ffmpeg binary, needed for Telegram voice notes
 */

/**
 * Parses dotenv text: `KEY=value`, optional `export ` prefix, `#` comments,
 * single or double quotes (double quotes expand \n).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Reads a dotenv file. Values already present in `base` (the process
 * environment) win, as with the usual dotenv convention.
 * @param {string} path
 * @param {Record<string, string | undefined>} [base]
 * @returns {Promise<Record<string, string | undefined>>}
 */
export async function loadEnvFile(path, base = process.env) {
  const parsed = parseDotenv(await readFile(path, "utf8"));
  return { ...parsed, ...Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined && v !== "")) };
}

/**
 * Builds and validates the agent configuration from an env map.
 * @param {Record<string, string | undefined>} env
 * @returns {AgentConfig}
 */
export function readConfig(env) {
  const missing = ["MODEL_BASE_URL", "MODEL_NAME", "WORKSPACE_MCP_URL", "WORKSPACE_AGENT_PAT"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing required settings: ${missing.join(", ")}`);
  const mcpUrl = /** @type {string} */ (env.WORKSPACE_MCP_URL);
  const num = (/** @type {string | undefined} */ v, /** @type {number} */ d) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
  };
  return {
    modelBaseUrl: /** @type {string} */ (env.MODEL_BASE_URL).replace(/\/+$/, ""),
    modelApiKey: env.MODEL_API_KEY ?? "",
    modelName: /** @type {string} */ (env.MODEL_NAME),
    prices: { input: num(env.MODEL_PRICE_IN, 0), output: num(env.MODEL_PRICE_OUT, 0) },
    mcpUrl,
    agentPat: /** @type {string} */ (env.WORKSPACE_AGENT_PAT),
    tokenUrl: env.WORKSPACE_AGENT_TOKEN_URL || `${new URL(mcpUrl).origin}/functions/v1/agent-token`,
    displayName: env.AGENT_DISPLAY_NAME ?? "",
    harness: env.AGENT_HARNESS_NAME || "reference-agent",
    resume: env.AGENT_RESUME !== "0",
    modelVision: env.WORKSPACE_MODEL_VISION === "1",
    modelPdf: env.WORKSPACE_MODEL_PDF === "1",
    reviewerAgentId: env.AGENT_REVIEWER_AGENT_ID ?? "",
    appUrl: (env.WORKSPACE_APP_URL ?? "").replace(/\/+$/, ""),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramOwnerChatId: env.TELEGRAM_OWNER_CHAT_ID ?? "",
    maxTurns: num(env.AGENT_MAX_TURNS, 40),
    inbox: env.AGENT_INBOX === "1" || env.TELEGRAM_TRANSPORT === "webhook",
    telegramTransport: env.TELEGRAM_TRANSPORT === "webhook" ? "webhook" : "polling",
    voiceUrl: env.WORKSPACE_VOICE_URL || `${new URL(mcpUrl).origin}/functions/v1/voice-transcribe`,
    timezone: env.AGENT_TIMEZONE ?? "",
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
  };
}
