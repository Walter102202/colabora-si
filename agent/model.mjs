// Model slot: any OpenAI-compatible chat completions endpoint with tool calling.
// Configured by base URL, key and model name; no provider SDK.

import { setTimeout as delay } from "node:timers/promises";

/**
 * @typedef {{id: string, type: "function", function: {name: string, arguments: string}}} ToolCall
 * @typedef {{role: "assistant", content: string | null, tool_calls?: ToolCall[]}} AssistantMessage
 * @typedef {{input_tokens: number, output_tokens: number, cached_tokens?: number}} Usage
 * @typedef {{message: AssistantMessage, usage: Usage, finish_reason?: string}} ChatResult
 * @typedef {{name: string, chat: (req: {messages: object[], tools?: object[], signal?: AbortSignal, reasoningEffort?: string, promptCacheKey?: string}) => Promise<ChatResult>}} Model
 */

/**
 * Normalizes an assistant message: arguments always a JSON string, ids always present.
 * @param {any} message
 * @returns {AssistantMessage}
 */
export function normalizeMessage(message) {
  /** @type {AssistantMessage} */
  const out = { role: "assistant", content: typeof message?.content === "string" ? message.content : null };
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (calls.length) {
    out.tool_calls = calls.map((/** @type {any} */ c, /** @type {number} */ i) => ({
      id: String(c.id ?? `call_${i}`),
      type: "function",
      function: {
        name: String(c.function?.name ?? ""),
        arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
      },
    }));
  }
  return out;
}

/** @param {number} attempt
 * @param {{baseDelayMs: number, maxDelayMs: number, random: () => number}} opts
 */
export function backoffDelayMs(attempt, { baseDelayMs, maxDelayMs, random }) {
  return Math.round(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.75 + random() * 0.5));
}

/** @param {string | null} header
 * @param {number} nowMs
 * @returns {number | null}
 */
export function parseRetryAfterMs(header, nowMs) {
  if (!header) return null;
  if (/^\d+$/.test(header)) return Math.min(60_000, Number(header) * 1000);
  const parsed = Date.parse(header);
  return Number.isFinite(parsed) ? Math.min(60_000, Math.max(0, parsed - nowMs)) : null;
}

/**
 * @param {{baseUrl: string, apiKey?: string, model: string, reasoningEffort?: string, fetchImpl?: typeof fetch, timeoutMs?: number, maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, random?: () => number}} opts
 * @returns {Model}
 */
export function createModel({ baseUrl, apiKey = "", model, reasoningEffort = "", fetchImpl = globalThis.fetch, timeoutMs = 180_000, maxAttempts = 4, baseDelayMs = 500, maxDelayMs = 8_000, sleep = (ms, signal) => delay(ms, undefined, { signal }), random = Math.random }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    name: model,
    async chat({ messages, tools, signal, reasoningEffort: effortForCall, promptCacheKey }) {
      /** @type {Record<string, unknown>} */
      const body = { model, messages };
      // A call may ask for more or less thinking than the instance default; an empty value omits the field.
      const effort = effortForCall ?? reasoningEffort;
      if (effort) body.reasoning_effort = effort;
      // Same key, same prefix: the provider's prefix cache serves the catalog and the system prompt from one agent to its next turn.
      if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
      /** @type {Record<string, string>} */
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        let res;
        let lastError;
        let retryAfter = null;
        try {
          const timeout = AbortSignal.timeout(timeoutMs);
          res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        } catch (e) {
          signal?.throwIfAborted();
          lastError = e;
        }
        if (res) {
          if (res.ok) {
            const json = await res.json();
            const choice = json?.choices?.[0];
            if (!choice?.message) throw new Error("model response has no choices");
            return {
              message: normalizeMessage(choice.message),
              usage: { input_tokens: Number(json.usage?.prompt_tokens ?? 0), output_tokens: Number(json.usage?.completion_tokens ?? 0),
                cached_tokens: Number(json.usage?.prompt_tokens_details?.cached_tokens ?? 0) },
              finish_reason: choice.finish_reason,
            };
          }
          lastError = new Error(`model request failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
          if (res.status !== 429 && res.status < 500) throw lastError;
          retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"), Date.now());
        }
        if (attempt >= maxAttempts) throw lastError;
        await sleep(retryAfter ?? backoffDelayMs(attempt, { baseDelayMs, maxDelayMs, random }), signal);
      }
    },
  };
}
