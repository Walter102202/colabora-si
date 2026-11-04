// Configuration of the reference agent: a dotenv parser and the env contract.
// No dependencies; runs on Node 22.

import { readFile } from "node:fs/promises";

/**
 * @typedef {object} AgentConfig
 * @property {string} modelBaseUrl      OpenAI-compatible base URL (POST {modelBaseUrl}/chat/completions)
 * @property {string} modelApiKey       bearer key for the model endpoint ("" for local endpoints)
 * @property {string} [memoryModelName]
 * @property {{input: number, output: number}} [memoryPrices]
 * @property {string} modelName         model id sent in every request
 * @property {string} modelEffort       reasoning effort of an ordinary task step (empty omits the provider field)
 * @property {string} modelEffortPlan   reasoning effort of a planning turn: the first one, and after an error, a conflict or a changed brief
 * @property {string} modelEffortChat   reasoning effort of the conversation with a person
 * @property {{input: number, output: number}} prices  USD per million tokens
 * @property {string} mcpUrl            remote MCP endpoint of the workspace (tasks)
 * @property {string} [workspaceMcpUrl] optional second endpoint with the page and database tools; its names join the catalog
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
    modelEffort: env.MODEL_REASONING_EFFORT ?? "",
    // A provider without reasoning_effort (empty step effort) keeps every turn unset unless a value is given explicitly.
    modelEffortPlan: env.MODEL_EFFORT_PLAN ?? (env.MODEL_REASONING_EFFORT ? "medium" : ""),
    modelEffortChat: env.MODEL_EFFORT_CHAT ?? (env.MODEL_REASONING_EFFORT ? "minimal" : ""),
    prices: { input: num(env.MODEL_PRICE_IN, 0), output: num(env.MODEL_PRICE_OUT, 0) },
    mcpUrl,
    workspaceMcpUrl: env.WORKSPACE_TOOLS_MCP_URL || undefined,
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

/**
 * The managed runtime reads the deployment's own variables, so it needs only the two secrets of the project.
 * @param {Record<string, string | undefined>} env
 * @returns {{runtimeUrl: string, secret: string, config: AgentConfig}}
 */
export function readFleetConfig(env) {
  const missing = ["VITE_SUPABASE_URL", "TRAMA_RUNTIME_SECRET", "META_MODEL_API_KEY"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing required settings: ${missing.join(", ")}`);
  const functions = `${/** @type {string} */ (env.VITE_SUPABASE_URL).replace(/\/+$/, "")}/functions/v1`;
  const modelName = env.MODEL_NAME || "muse-wonder-1.0";
  const priceMap = new Map([
    ["muse-wonder-1.0", { input: 4, output: 20 }],
    ["muse-spark-1.3", { input: 1.25, output: 4.25 }],
  ]);
  const prices = priceMap.get(modelName) ?? { input: 0, output: 0 };
  const memoryModelName = env.MODEL_NAME_MEMORY || "muse-spark-1.3";
  return {
    runtimeUrl: `${functions}/trama-runtime`,
    secret: /** @type {string} */ (env.TRAMA_RUNTIME_SECRET),
    config: { memoryModelName, memoryPrices: priceMap.get(memoryModelName) ?? { input: 0, output: 0 }, ...readConfig({
      MODEL_BASE_URL: env.MODEL_BASE_URL || "https://api.meta.ai/v1",
      MODEL_NAME: modelName,
      MODEL_REASONING_EFFORT: env.MODEL_REASONING_EFFORT ?? "low",
      MODEL_EFFORT_PLAN: env.MODEL_EFFORT_PLAN,
      MODEL_EFFORT_CHAT: env.MODEL_EFFORT_CHAT,
      MODEL_PRICE_IN: String(prices.input),
      MODEL_PRICE_OUT: String(prices.output),
      MODEL_API_KEY: env.META_MODEL_API_KEY,
      WORKSPACE_MCP_URL: `${functions}/mcp`,
      WORKSPACE_TOOLS_MCP_URL: `${functions}/workspace-mcp`,
      WORKSPACE_AGENT_PAT: "managed",
      WORKSPACE_APP_URL: env.VITE_APP_URL,
      AGENT_HARNESS_NAME: "trama",
      AGENT_DISPLAY_NAME: "Trama",
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_TRANSPORT: "webhook",
    }) },
  };
}
