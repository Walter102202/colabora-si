// Client for the remote MCP endpoint (Streamable HTTP, POST only).
//
// The agent's personal access token (PAT) is exchanged for a short-lived JWT
// at the `agent-token` function; every MCP request carries that JWT. A 401
// triggers exactly one new exchange and one retry.

import { createSseParser } from "./jsonrpc.mjs";

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const REFRESH_MARGIN_MS = 60_000;

export class RemoteError extends Error {
  /**
   * @param {string} code
   * @param {number} [status]
   * @param {string} [detail]
   */
  constructor(code, status, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RemoteError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Default token endpoint: `<origin of the MCP URL>/functions/v1/agent-token`.
 * @param {string} mcpUrl
 */
export function defaultTokenUrl(mcpUrl) {
  return `${new URL(mcpUrl).origin}/functions/v1/agent-token`;
}

/**
 * Reads every JSON-RPC message of an HTTP response (JSON body, JSON array or
 * an SSE stream), calling `onMessage` as each one arrives.
 * @param {Response} res
 * @param {(message: any) => void} [onMessage]
 * @returns {Promise<any[]>}
 */
export async function readMessages(res, onMessage) {
  /** @type {any[]} */
  const messages = [];
  /** @param {any} m */
  const deliver = (m) => { messages.push(m); onMessage?.(m); };
  if (res.status === 202 || res.status === 204) return messages;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const parser = createSseParser((data) => {
      try { deliver(JSON.parse(data)); } catch { /* keep-alive or non-JSON event */ }
    });
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } else {
      parser.push(await res.text());
    }
    parser.end();
    return messages;
  }
  const text = await res.text();
  if (!text.trim()) return messages;
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new RemoteError(res.ok ? "invalid_response" : `http_${res.status}`, res.status, text.slice(0, 200));
  }
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) deliver(m);
  return messages;
}

/**
 * @param {{
 *   mcpUrl: string,
 *   pat: string,
 *   tokenUrl?: string,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 *   log?: (message: string) => void,
 *   clientInfo?: { name: string, version: string },
 * }} options
 */
export function createRemote(options) {
  const { mcpUrl, pat } = options;
  const tokenUrl = options.tokenUrl || defaultTokenUrl(mcpUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const clientInfo = options.clientInfo ?? { name: "colabora-bridge", version: "0.1.0" };

  /** @type {string | null} */ let jwt = null;
  let expiresAt = 0;
  /** @type {string | null} */ let agentId = null;
  /** @type {string | null} */ let workspaceId = null;
  /** @type {Promise<any> | null} */ let exchanging = null;
  /** @type {string | null} */ let sessionId = null;
  /** @type {Promise<void> | null} */ let sessionReady = null;
  /** @type {string} */ let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  /** @type {any} */ let initParams = null;
  let nextId = 1;
  /** @type {Set<(token: string) => void>} */ const tokenListeners = new Set();

  async function doExchange() {
    if (!pat) throw new RemoteError("missing_pat", undefined, "WORKSPACE_AGENT_PAT is not set");
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token: pat }),
    });
    /** @type {any} */ let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || !body?.access_token) {
      throw new RemoteError(body?.error ?? `http_${res.status}`, res.status, body?.error_description);
    }
    jwt = body.access_token;
    expiresAt = now() + (Number(body.expires_in) || 3600) * 1000;
    agentId = body.agent_id ?? agentId;
    workspaceId = body.workspace_id ?? workspaceId;
    log(`token exchanged for agent ${agentId ?? "?"}`);
    for (const listener of tokenListeners) listener(body.access_token);
    return body;
  }

  /** Exchanges the PAT for a JWT (concurrent callers share one request). */
  function exchange() {
    if (!exchanging) exchanging = doExchange().finally(() => { exchanging = null; });
    return exchanging;
  }

  async function ensureToken() {
    if (!jwt || now() > expiresAt - REFRESH_MARGIN_MS) await exchange();
    return /** @type {string} */ (jwt);
  }

  /** @param {Record<string, string>} [extra] */
  function headersFor(extra) {
    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${jwt}`,
      "Mcp-Protocol-Version": protocolVersion,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    return { ...headers, ...(extra ?? {}) };
  }

  /**
   * POST with the current JWT; on 401 exchanges once and retries once.
   * @param {any} body
   * @param {Record<string, string>} [extra]
   */
  async function post(body, extra) {
    await ensureToken();
    const send = () => fetchImpl(mcpUrl, { method: "POST", headers: headersFor(extra), body: JSON.stringify(body) });
    let res = await send();
    if (res.status === 401) {
      log("remote answered 401; exchanging the token again");
      await res.text().catch(() => "");
      await exchange();
      res = await send();
    }
    return res;
  }

  async function initSession() {
    // Token and network failures propagate (the next call tries again); an
    // HTTP error answer only means the remote keeps no session.
    const params = initParams ?? { protocolVersion, capabilities: {}, clientInfo };
    const res = await post({ jsonrpc: "2.0", id: `bridge-init-${nextId++}`, method: "initialize", params });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const messages = await readMessages(res).catch(() => []);
    const result = messages.find((m) => m && "result" in m)?.result;
    if (result?.protocolVersion && result.protocolVersion !== protocolVersion) {
      log(`remote negotiated protocol ${result.protocolVersion} (client asked ${protocolVersion})`);
    }
    if (res.ok) await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text().catch(() => "");
    else log(`remote initialize answered ${res.status}; continuing without a session`);
  }

  function ensureSession() {
    if (!sessionReady) sessionReady = initSession().catch((error) => { sessionReady = null; throw error; });
    return sessionReady;
  }

  /**
   * Forwards one JSON-RPC message (body unchanged) and returns the messages of
   * the response. Extra headers (such as `Mcp-Protocol-Version`) are sent as given.
   * @param {any} body
   * @param {{ headers?: Record<string, string>, onMessage?: (message: any) => void }} [opts]
   */
  async function call(body, opts = {}) {
    await ensureSession();
    let res = await post(body, opts.headers);
    if (res.status === 404 && sessionId) {
      log("remote session expired; starting a new one");
      await res.text().catch(() => "");
      sessionId = null;
      sessionReady = null;
      await ensureSession();
      res = await post(body, opts.headers);
    }
    const messages = await readMessages(res, opts.onMessage);
    if (!res.ok && !messages.some((m) => m && m.jsonrpc === "2.0")) {
      throw new RemoteError(`http_${res.status}`, res.status);
    }
    return { status: res.status, messages };
  }

  /**
   * Calls a remote tool and returns its structured result.
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async function callTool(name, args) {
    const id = `bridge-${nextId++}`;
    const { messages } = await call({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const response = messages.find((m) => m && m.id === id);
    if (!response) throw new RemoteError("no_response");
    if (response.error) throw new RemoteError(String(response.error.message ?? "rpc_error"), undefined, JSON.stringify(response.error.data ?? ""));
    const result = response.result ?? {};
    let structured = result.structuredContent;
    if (structured === undefined) {
      const text = result.content?.find?.((/** @type {any} */ c) => c.type === "text")?.text;
      try { structured = text ? JSON.parse(text) : {}; } catch { structured = { text }; }
    }
    if (result.isError) throw new RemoteError(String(structured?.code ?? "tool_error"), undefined, structured?.message);
    return structured;
  }

  return {
    exchange,
    ensureToken,
    call,
    callTool,
    get token() { return jwt; },
    get agentId() { return agentId; },
    get workspaceId() { return workspaceId; },
    get expiresAt() { return expiresAt; },
    get sessionId() { return sessionId; },
    get protocolVersion() { return protocolVersion; },
    /** @param {string} version */
    setProtocolVersion(version) { protocolVersion = version; },
    /** Params of the client's `initialize`, reused for the remote session. @param {any} params */
    setInitParams(params) { initParams = params; },
    /** @param {(token: string) => void} listener */
    onToken(listener) { tokenListeners.add(listener); return () => tokenListeners.delete(listener); },
  };
}
