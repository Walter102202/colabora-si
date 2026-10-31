import { expect, it } from "vitest";
import { REQUEST_TOOLS } from "../../agent/loop.mjs";
import { runRequest } from "../../agent/requests.mjs";
import { createStubMcp } from "../../agent/test/stub-mcp.mjs";
import { createStubModel } from "../../agent/test/stub-model.mjs";

const lessonRequest = { kind: "lesson", task_id: "t", source: { title: "Report" }, corrections: [{ text: "Dates are DD/MM/YYYY", kind: "review" }], known: [] };

function harness(request: object, contents: string[], kind: string) {
  const mcp = createStubMcp({ handlers: {
    get_ai_request: () => request,
    propose_lesson: () => ({ lesson_id: "l1", status: "proposed" }),
    complete_lesson_request: () => ({ task_state: "done" }),
  } });
  const model = createStubModel(contents.map((content) => ({ content, usage: { prompt_tokens: 10, completion_tokens: 5 } })));
  const opts = { call: mcp.callTool, model, task: { task_id: "t", request_kind: kind }, runId: "run", log: () => {}, prices: { input: 1, output: 1 } };
  const named = (name: string) => mcp.calls.filter((c: { name: string }) => c.name === name);
  return { mcp, opts, named };
}

it("a correction becomes one proposal with a retry-safe key", async () => {
  const h = harness(lessonRequest, [JSON.stringify({ text: "Client reports use DD/MM/YYYY", example: "30/10/2026" })], "lesson");
  expect((await runRequest(h.opts)).status).toBe("completed");
  expect(h.named("propose_lesson")[0].args).toMatchObject({ run_id: "run", text: "Client reports use DD/MM/YYYY", example: "30/10/2026", idempotency_key: "lesson:t" });
  expect(h.named("complete_lesson_request")[0].args).toMatchObject({ summary: "Proposed one lesson." });
});

it("the model can decline, and nothing is proposed", async () => {
  const h = harness(lessonRequest, [JSON.stringify({ skip: true, reason: "Only this task" })], "lesson");
  expect((await runRequest(h.opts)).summary).toBe("No lesson: Only this task");
  expect(h.named("propose_lesson")).toEqual([]);
});

it("broken JSON is retried once, then the request fails", async () => {
  const h = harness(lessonRequest, ["broken", "still broken"], "lesson");
  expect((await runRequest(h.opts)).status).toBe("failed");
  expect(h.named("propose_lesson")).toEqual([]);
});

it("the closing tool stays hidden from the model", () => {
  expect(REQUEST_TOOLS.has("complete_lesson_request")).toBe(true);
});
