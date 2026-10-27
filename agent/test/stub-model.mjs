// Scripted stand-in for an OpenAI-compatible chat completions endpoint.
// Each request consumes the next scripted step; nothing leaves the machine.

import { createServer } from "node:http";

/**
 * @typedef {{content?: string, tool_calls?: {name: string, arguments?: Record<string, unknown>}[], usage?: {prompt_tokens: number, completion_tokens: number}}} ScriptStep
 */

/**
 * Shorthand for a scripted tool call.
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
export const toolCall = (name, args = {}) => ({ name, arguments: args });

/**
 * Builds the chat completions response body for a step.
 * @param {ScriptStep | undefined} step
 * @param {number} index
 */
export function completionFor(step, index) {
  const s = step ?? { content: "Nothing left to do." };
  const toolCalls = (s.tool_calls ?? []).map((c, i) => ({
    id: `call_${index}_${i}`,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
  const usage = s.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
  return {
    id: `chatcmpl-stub-${index}`,
    object: "chat.completion",
    created: 0,
    model: "stub",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: s.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

/**
 * In-process model with the same interface as `createModel` from agent/model.mjs.
 * @param {ScriptStep[]} script
 * @param {{name?: string}} [opts]
 */
export function createStubModel(script, { name = "stub-model" } = {}) {
  /** @type {{messages: any[], tools?: any[]}[]} */
  const requests = [];
  return {
    name,
    requests,
    /** @param {{messages: any[], tools?: any[]}} req */
    async chat(req) {
      requests.push(structuredClone(req));
      const body = completionFor(script[requests.length - 1], requests.length - 1);
      const choice = body.choices[0];
      return {
        message: /** @type {any} */ (choice.message),
        usage: { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens },
        finish_reason: choice.finish_reason,
      };
    },
  };
}

/**
 * Local HTTP server answering `POST /chat/completions` from the script.
 * @param {ScriptStep[]} script
 * @param {{port?: number}} [opts]
 * @returns {Promise<{url: string, requests: any[], close: () => Promise<void>}>}
 */
export async function startStubModelServer(script, { port = 0 } = {}) {
  /** @type {any[]} */
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      requests.push(JSON.parse(raw || "{}"));
      const body = completionFor(script[requests.length - 1], requests.length - 1);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
