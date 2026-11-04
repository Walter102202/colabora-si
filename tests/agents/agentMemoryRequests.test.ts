import { describe, expect, it } from "vitest";
import { runRequest } from "../../agent/requests.mjs";
import { createStubMcp } from "../../agent/test/stub-mcp.mjs";
import { createStubModel } from "../../agent/test/stub-model.mjs";

describe("memory extraction requests", () => {
  it.each(["separate", "fallback", "empty", "invalid", "voice"])("handles %s without leaking input into logs", async (mode) => {
    const request = { kind: "memory", through_seq: 8, memories: [], messages: mode === "empty" ? [] : [{ id: "m", text: "I prefer concise answers", voice: mode === "voice" }] };
    const model = createStubModel([{ content: '{"ops":[]}' }]);
    const memoryModel = Object.assign(createStubModel([{ content: mode === "invalid" ? "invalid" : '{"ops":[]}', usage: { prompt_tokens: 10, completion_tokens: 5 } }, { content: "invalid" }]), { name: mode === "voice" ? "spark-contributor" : "muse-spark-1.3" });
    const mcp = createStubMcp({ handlers: { get_ai_request: () => request, heartbeat: () => ({}), apply_memory_updates: () => ({ added: 0, replaced: 0, rejected: [] }), fail_task: () => ({}) } });
    const logs: string[] = [];
    const result = await runRequest({ call: mcp.callTool, model, ...(mode !== "fallback" ? { memoryModel, memoryPrices: { input: 1.25, output: 4.25 } } : {}), task: { task_id: "t", request_kind: "memory" }, runId: "r", log: (s) => logs.push(s) });
    const applied = mcp.calls.find((c) => c.name === "apply_memory_updates");
    if (["invalid", "voice"].includes(mode)) {
      expect(result.status).toBe("failed"); expect(applied).toBeUndefined();
    } else {
      expect(result.status).toBe("completed");
      expect(applied?.args).toMatchObject({ run_id: "r", ops: [], through_seq: 8 });
    }
    if (["empty", "voice"].includes(mode)) expect(memoryModel.requests).toHaveLength(0);
    if (mode === "separate") {
      expect(model.requests).toHaveLength(0);
      expect(memoryModel.requests).toHaveLength(1);
      expect(applied?.args.usage).toMatchObject({ model: "muse-spark-1.3", input_tokens: 10, output_tokens: 5, cost_usd: 0.00003375 });
    }
    if (mode === "fallback") expect(model.requests).toHaveLength(1);
    expect(logs.join(" ")).not.toContain("concise answers");
  });
});
