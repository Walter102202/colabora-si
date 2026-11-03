// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunsCard, type RunsCardRun } from "@/components/agents/panel";

const run = (over: Partial<RunsCardRun> = {}): RunsCardRun => ({
  id: "r1",
  agentName: "Trama",
  harness: "agent",
  model: "muse-wonder-1.0",
  status: "completed",
  inputTokens: 114328,
  outputTokens: 1589,
  costUsd: 0.4891,
  costKind: "measured",
  startedAt: "2026-11-03T08:00:00Z",
  endedAt: "2026-11-03T08:03:05Z",
  errorMessage: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (runs: RunsCardRun[]) => act(() => root.render(createElement(RunsCard, { runs })));
const cells = () => [...container.querySelectorAll("tbody tr:first-child td")].map((c) => c.textContent);

describe("RunsCard", () => {
  it("renders the heading, caption and columns", () => {
    render([run()]);
    expect(container.querySelector("caption")?.textContent).toBe("Runs & cost");
    expect([...container.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Agent", "Model", "Status", "In", "Out", "Cost", "Duration"]);
  });

  it("shows the model label with the raw id in the title and Meta as a suffix, never the id as text", () => {
    render([run()]);
    const model = container.querySelectorAll("tbody td")[1];
    expect(model.querySelector("span[title]")?.getAttribute("title")).toBe("muse-wonder-1.0");
    expect(model.textContent).toContain("Muse Wonder 1.0");
    expect(model.textContent).toContain("Meta");
    expect(model.textContent).not.toContain("muse-wonder-1.0");
  });

  it("formats tokens, cost and duration, with exact values in titles", () => {
    render([run()]);
    const row = cells();
    expect(row[2]).toBe("Ended");
    expect(row[3]).toBe("114.3k");
    expect(row[4]).toBe("1.6k");
    expect(row[5]).toBe("$0.49");
    expect(row[6]).toBe("3m 05s");
    const tds = container.querySelectorAll("tbody td");
    expect(tds[3].querySelector("span")?.getAttribute("title")).toBe("114,328");
    expect(tds[4].querySelector("span")?.getAttribute("title")).toBe("1,589");
    expect(tds[5].querySelector("span")?.getAttribute("title")).toBe("$0.4891");
  });

  it("marks estimated cost and shows running while a run has no end", () => {
    render([run({ status: "running", costUsd: 0.0096, costKind: "estimated", endedAt: null })]);
    const row = cells();
    expect(row[2]).toBe("Running");
    expect(row[5]).toBe("$0.0096 est.");
    expect(row[6]).toBe("running");
    expect(container.querySelectorAll("tbody td")[5].querySelector("span")?.getAttribute("title")).toBe("$0.0096, estimated");
  });

  it("shows a dash for unknown zero cost", () => {
    render([run({ costUsd: 0, costKind: "unknown" })]);
    expect(cells()[5]).toBe("—");
  });

  it("carries the exact cost to six decimals in the title", () => {
    render([run({ costUsd: 0.000012 })]);
    expect(cells()[5]).toBe("<$0.0001");
    expect(container.querySelectorAll("tbody td")[5].querySelector("span")?.getAttribute("title")).toBe("$0.000012");
  });

  it("marks a positive unmeasured cost as estimated, in the row and the total", () => {
    render([run({ costUsd: 0.0096, costKind: "unknown" })]);
    expect(cells()[5]).toBe("$0.0096 est.");
    expect(container.querySelectorAll("tbody td")[5].querySelector("span")?.getAttribute("title")).toBe("$0.0096, estimated");
    const total = [...container.querySelectorAll("tfoot td")].map((c) => c.textContent);
    expect(total[5]).toBe("$0.0096 est.");
  });

  it("dashes the totals when every run reports nothing", () => {
    const blank = (id: string) => run({ id, agentName: null, harness: "codex", model: null, inputTokens: 0, outputTokens: 0, costUsd: 0, costKind: "unknown" });
    render([blank("r1"), blank("r2")]);
    const total = [...container.querySelectorAll("tfoot td")].map((c) => c.textContent);
    expect(total[0]).toBe("Total");
    expect(total[3]).toBe("—");
    expect(total[4]).toBe("—");
    expect(total[5]).toBe("—");
  });

  it("pads cells, separates rows and scrolls the table sideways", () => {
    render([run({ status: "error", errorMessage: "Boom." })]);
    expect(container.querySelector("div.overflow-x-auto")).not.toBeNull();
    expect(container.querySelector("th")?.className).toContain("px-2");
    expect(container.querySelector("th")?.className).toContain("py-1.5");
    expect(container.querySelector("tbody td")?.className).toContain("px-2");
    expect(container.querySelector("tbody tr")?.className).toContain("border-b");
    expect(container.querySelector("tfoot tr")?.className).toContain("border-t");
    const errorCell = [...container.querySelectorAll("tbody td")].find((c) => c.textContent === "Boom.");
    expect(errorCell?.className).toContain("pt-0");
  });

  it("shows Not reported by harness and dashed tokens when a run has no model and no tokens", () => {
    render([run({ agentName: null, harness: "codex", model: null, inputTokens: 0, outputTokens: 0, costUsd: 0, costKind: "unknown" })]);
    const row = cells();
    expect(row[0]).toBe("codex");
    expect(row[1]).toBe("Not reported by harness");
    expect(row[3]).toBe("—");
    expect(row[4]).toBe("—");
  });

  it("still shows tokens for a run with no model that reported them, and 0 output for a modelled run", () => {
    render([run({ model: null, inputTokens: 2411, outputTokens: 0 })]);
    expect(cells()[3]).toBe("2.4k");
    expect(cells()[4]).toBe("0");
    render([run({ outputTokens: 0 })]);
    expect(cells()[4]).toBe("0");
  });

  it("maps status labels and passes unknown statuses through", () => {
    render([run({ status: "waiting" }), run({ id: "r2", status: "error" }), run({ id: "r3", status: "cancelled" }), run({ id: "r4", status: "queued" })]);
    const statuses = [...container.querySelectorAll("tbody tr")].filter((tr) => tr.querySelectorAll("td").length === 7).map((tr) => tr.querySelectorAll("td")[2].textContent);
    expect(statuses).toEqual(["Waiting", "Failed", "Cancelled", "queued"]);
  });

  it("renders the error message under its row", () => {
    render([run({ status: "error", errorMessage: "The model returned invalid JSON." })]);
    expect(container.textContent).toContain("The model returned invalid JSON.");
  });

  it("adds a totals row summing tokens and cost, marked when any run is estimated", () => {
    render([run(), run({ id: "r2", inputTokens: 2411, outputTokens: 0, costUsd: 0.0096, costKind: "estimated" })]);
    const total = container.querySelector("tfoot tr");
    const tds = [...(total?.querySelectorAll("td") ?? [])].map((c) => c.textContent);
    expect(tds[0]).toBe("Total");
    expect(tds[3]).toBe("116.7k");
    expect(tds[4]).toBe("1.6k");
    expect(tds[5]).toBe("$0.50 est.");
    expect(total?.querySelectorAll("td")[3].querySelector("span")?.getAttribute("title")).toBe("116,739");
    expect(total?.querySelectorAll("td")[5].querySelector("span")?.getAttribute("title")).toBe("$0.4987, part estimated");
  });

  it("renders the heading and the empty state with no runs", () => {
    render([]);
    expect(container.textContent).toContain("Runs & cost");
    expect(container.textContent).toContain("No runs yet.");
    expect(container.querySelector("table")).toBeNull();
  });
});
