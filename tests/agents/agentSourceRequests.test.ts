import { expect, it } from "vitest";
import { REQUEST_TOOLS } from "../../agent/loop.mjs";
import { runRequest } from "../../agent/requests.mjs";
import { createStubMcp } from "../../agent/test/stub-mcp.mjs";
import { createStubModel } from "../../agent/test/stub-model.mjs";

const sourceRequest = { kind: "source_check", task_id: "t", page: { id: "d", title: "Proposal", text: "We charge 10" },
  sources: [{ id: "s1", title: "Pricing", text: "Price is 12", fingerprint: "f1", revision: 3, deleted: false, files: [] }] };

function harness(request: object, contents: string[], kind: string) {
  const mcp = createStubMcp({ handlers: {
    get_ai_request: () => request,
    report_source_check: () => ({ verdict: "current", task_state: "done" }),
  } });
  const model = createStubModel(contents.map((content) => ({ content, usage: { prompt_tokens: 10, completion_tokens: 5 } })));
  const opts = { call: mcp.callTool, model, task: { task_id: "t", request_kind: kind }, runId: "run", log: () => {}, prices: { input: 1, output: 1 } };
  const named = (name: string) => mcp.calls.filter((c: { name: string }) => c.name === name);
  return { mcp, opts, named };
}

it("a source check reports what it compared", async () => {
  const h = harness(sourceRequest, [JSON.stringify({ verdict: "current" })], "source_check");
  await runRequest(h.opts);
  expect(h.named("report_source_check")[0].args).toMatchObject({ verdict: "current", items: [], checked: [{ id: "s1", fingerprint: "f1", revision: 3 }] });
});

it("a contradiction keeps only items about sources it was given", async () => {
  const h = harness(sourceRequest, [JSON.stringify({ verdict: "discrepancy", summary: "Prices differ", items: [
    { source_id: "s1", source_says: "12", page_says: "10" }, { source_id: "other", source_says: "x", page_says: "y" }] })], "source_check");
  await runRequest(h.opts);
  expect(h.named("report_source_check")[0].args).toMatchObject({ verdict: "discrepancy", summary: "Prices differ", items: [{ source_id: "s1", source_says: "12", page_says: "10" }] });
});

it("the reporting tool stays hidden from the model", () => {
  expect(REQUEST_TOOLS.has("report_source_check")).toBe(true);
});
