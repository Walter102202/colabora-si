// Minimal MCP client over HTTP (JSON-RPC 2.0, POST-only Streamable HTTP).
// Authenticates by exchanging the agent PAT for a short-lived JWT.

/**
 * @typedef {{name: string, title?: string, description?: string, inputSchema?: Record<string, any>}} McpTool
 * @typedef {{type: "function", function: {name: string, description: string, parameters: Record<string, any>}}} OpenAiTool
 * @typedef {{isError: boolean, data: Record<string, any>, text: string}} ToolResult
 * @typedef {object} McpClient
 * @property {() => Promise<void>} initialize
 * @property {() => Promise<McpTool[]>} listTools
 * @property {(fresh?: boolean) => Promise<string>} accessToken  the agent's JWT, for a workspace function that is not MCP
 * @property {(name: string, args: Record<string, unknown>) => Promise<ToolResult>} callTool
 * @property {string} [instructions]
 */

const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  /** @param {string} message @param {number} [code] @param {number} [status] */
  constructor(message, code, status) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Converts MCP tool definitions to the `tools` array of chat completions.
 * @param {McpTool[]} tools
 * @returns {OpenAiTool[]}
 */
export function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.title || t.name,
      parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
    },
  }));
}

/**
 * Turns a `tools/call` result into `{isError, data, text}`: `data` is the
 * structured content, or the text parsed as JSON, or `{text}`.
 * @param {any} result
 * @returns {ToolResult}
 */
export function toToolResult(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((/** @type {any} */ c) => c?.type === "text")
    .map((/** @type {any} */ c) => c.text)
    .join("\n");
  let data = result?.structuredContent;
  if (!data || typeof data !== "object") {
    try {
      const parsed = JSON.parse(text);
      data = parsed && typeof parsed === "object" ? parsed : { text };
    } catch {
      data = { text };
    }
  }
  return { isError: Boolean(result?.isError), data, text };
}

/**
 * Reads a JSON-RPC response from a JSON or SSE body.
 * @param {Response} res
 * @param {number} id
 */
async function readRpcResponse(res, id) {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!type.includes("text/event-stream")) return body ? JSON.parse(body) : null;
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const msg = JSON.parse(data);
    if (msg && msg.id === id) return msg;
  }
  throw new McpError("no response in event stream");
}

/**
 * @param {{url: string, pat: string, tokenUrl: string, fetchImpl?: typeof fetch, clientName?: string, timeoutMs?: number}} opts
 * @returns {McpClient}
 */
export function createMcpClient({ url, pat, tokenUrl, fetchImpl = globalThis.fetch, clientName = "reference-agent", timeoutMs = 150_000 }) {
  /** @type {string | null} */
  let token = null;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {Promise<void> | null} */
  let initializing = null;
  let nextId = 1;

  async function exchange() {
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pat }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new McpError(`token exchange failed: ${json.error ?? `HTTP ${res.status}`}`, undefined, res.status);
    }
    token = json.access_token;
    return token;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown> | undefined} params
   * @param {boolean} notification
   */
  async function send(method, params, notification) {
    const id = nextId++;
    const payload = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = token ?? (await exchange());
      /** @type {Record<string, string>} */
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${bearer}`,
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      };
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (notification || res.status === 202) return null;
      if (!res.ok) throw new McpError(`MCP ${method} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, undefined, res.status);
      const msg = await readRpcResponse(res, id);
      if (msg?.error) throw new McpError(`MCP ${method} error: ${msg.error.message}`, msg.error.code, res.status);
      return msg?.result ?? null;
    }
    throw new McpError(`MCP ${method} unauthorized`, undefined, 401);
  }

  /** @type {McpClient} */
  const client = {
    instructions: undefined,
    initialize() {
      initializing ??= (async () => {
        const result = await send(
          "initialize",
          { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
          false,
        );
        client.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
        await send("notifications/initialized", undefined, true);
      })();
      initializing.catch(() => {
        initializing = null;
      });
      return initializing;
    },
    async accessToken(fresh = false) {
      if (fresh) token = null;
      return token ?? (await exchange());
    },
    async listTools() {
      await client.initialize();
      /** @type {McpTool[]} */
      const tools = [];
      /** @type {string | undefined} */
      let cursor;
      do {
        const result = await send("tools/list", cursor ? { cursor } : {}, false);
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args) {
      await client.initialize();
      return toToolResult(await send("tools/call", { name, arguments: args }, false));
    },
  };
  return client;
}
