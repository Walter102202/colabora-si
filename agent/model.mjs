// Model slot: any OpenAI-compatible chat completions endpoint with tool calling.
// Configured by base URL, key and model name; no provider SDK.

/**
 * @typedef {{id: string, type: "function", function: {name: string, arguments: string}}} ToolCall
 * @typedef {{role: "assistant", content: string | null, tool_calls?: ToolCall[]}} AssistantMessage
 * @typedef {{input_tokens: number, output_tokens: number}} Usage
 * @typedef {{message: AssistantMessage, usage: Usage, finish_reason?: string}} ChatResult
 * @typedef {{name: string, chat: (req: {messages: object[], tools?: object[]}) => Promise<ChatResult>}} Model
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

/**
 * @param {{baseUrl: string, apiKey?: string, model: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Model}
 */
export function createModel({ baseUrl, apiKey = "", model, fetchImpl = globalThis.fetch, timeoutMs = 180_000 }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    name: model,
    async chat({ messages, tools }) {
      /** @type {Record<string, unknown>} */
      const body = { model, messages };
      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
      /** @type {Record<string, string>} */
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`model request failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
      const json = await res.json();
      const choice = json?.choices?.[0];
      if (!choice?.message) throw new Error("model response has no choices");
      return {
        message: normalizeMessage(choice.message),
        usage: { input_tokens: Number(json.usage?.prompt_tokens ?? 0), output_tokens: Number(json.usage?.completion_tokens ?? 0) },
        finish_reason: choice.finish_reason,
      };
    },
  };
}
