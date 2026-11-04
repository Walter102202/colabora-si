import { expect, it } from "vitest";
import { createMcpClient } from "../../agent/mcpClient.mjs";

it("MA-1 callTool rejects at once when its signal aborts", async () => {
  const fetchImpl = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const client = createMcpClient({ url: "http://127.0.0.1:1/mcp", signIn: async () => "jwt", fetchImpl: fetchImpl as typeof fetch });
  client.initialize = async () => {};
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);
  const started = Date.now();
  await expect(client.callTool("wait_for_task", {}, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(Date.now() - started).toBeLessThan(1000);
});

it("MA-2 callTool without a signal still carries the timeout signal", async () => {
  let seen: AbortSignal | undefined;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    seen = init.signal as AbortSignal;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), { headers: { "content-type": "application/json" } });
  };
  const client = createMcpClient({ url: "http://127.0.0.1:1/mcp", signIn: async () => "jwt", fetchImpl: fetchImpl as typeof fetch });
  client.initialize = async () => {};
  await client.callTool("x", {});
  expect(seen?.aborted).toBe(false);
  expect(seen).toBeInstanceOf(AbortSignal);
});
