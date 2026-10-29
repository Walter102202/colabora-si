import { describe, expect, it } from "vitest";
import { backoffDelayMs, createModel, parseRetryAfterMs } from "../../agent/model.mjs";
import { startStubModelServer } from "../../agent/test/stub-model.mjs";

const ok = (content = "done") => Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const fail = (status: number, headers: Record<string, string> = {}) => new Response("busy", { status, headers });

/** fetch that answers from a queue and records every call; `sleep` records the delays instead of waiting. */
function fakeFetch(queue: (Response | Error)[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}
function recorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}
const model = (f: ReturnType<typeof fakeFetch>, r: ReturnType<typeof recorder>, extra: Record<string, unknown> = {}) =>
  createModel({ baseUrl: "http://m.test/v1", apiKey: "k", model: "stub", fetchImpl: f.fetchImpl, sleep: r.sleep, random: () => 0.5, ...extra });

describe("backoff policy", () => {
  it("doubles from the base with the cap, and the jitter stays within ±25 %", () => {
    const o = { baseDelayMs: 500, maxDelayMs: 8000, random: () => 0.5 };
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelayMs(a, o))).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(backoffDelayMs(1, { ...o, random: () => 0 })).toBe(375);
    expect(backoffDelayMs(1, { ...o, random: () => 1 })).toBe(625);
  });
  it("reads Retry-After as seconds or as an HTTP date", () => {
    const now = Date.parse("2026-10-29T10:00:00Z");
    expect(parseRetryAfterMs("2", now)).toBe(2000);
    expect(parseRetryAfterMs("Wed, 29 Oct 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfterMs("garbage", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("600", now)).toBe(60_000);
  });
});

describe("createModel retries", () => {
  it("retries a 429 after the Retry-After the server asked for", async () => {
    const f = fakeFetch([fail(429, { "Retry-After": "1" }), ok()]);
    const r = recorder();
    const res = await model(f, r).chat({ messages: [] });
    expect(res.message.content).toBe("done");
    expect(f.calls).toHaveLength(2);
    expect(r.delays).toEqual([1000]);
  });
  it("retries 5xx with exponential backoff and jitter", async () => {
    const f = fakeFetch([fail(503), fail(502), ok()]);
    const r = recorder();
    await model(f, r).chat({ messages: [] });
    expect(f.calls).toHaveLength(3);
    expect(r.delays).toEqual([500, 1000]);
  });
  it("retries a timeout", async () => {
    const f = fakeFetch([new DOMException("timeout", "TimeoutError"), ok()]);
    const r = recorder();
    await model(f, r).chat({ messages: [] });
    expect(f.calls).toHaveLength(2);
    expect(r.delays).toEqual([500]);
  });
  it("does not retry other 4xx", async () => {
    const f = fakeFetch([fail(400), ok()]);
    const r = recorder();
    await expect(model(f, r).chat({ messages: [] })).rejects.toThrow(/HTTP 400/);
    expect(f.calls).toHaveLength(1);
    expect(r.delays).toEqual([]);
  });
  it("gives up after maxAttempts with the last error", async () => {
    const f = fakeFetch([fail(503), fail(503), fail(503), fail(503), ok()]);
    const r = recorder();
    await expect(model(f, r).chat({ messages: [] })).rejects.toThrow(/HTTP 503/);
    expect(f.calls).toHaveLength(4);
    expect(r.delays).toEqual([500, 1000, 2000]);
  });
});

describe("stub model server failures", () => {
  it("serves scripted failures before the script and the real adapter recovers", async () => {
    const server = await startStubModelServer([{ content: "hello" }], { failures: [{ status: 429, retryAfter: 0 }, { status: 503 }, { timeout: true, holdMs: 200 }] });
    try {
      const r = recorder();
      const m = createModel({ baseUrl: server.url, apiKey: "k", model: "stub", timeoutMs: 50, sleep: r.sleep, random: () => 0.5 });
      const res = await m.chat({ messages: [{ role: "user", content: "hi" }] });
      expect(res.message.content).toBe("hello");
      expect(server.requests).toHaveLength(4);
      expect(r.delays).toEqual([0, 1000, 2000]);
    } finally {
      await server.close();
    }
  });
});
