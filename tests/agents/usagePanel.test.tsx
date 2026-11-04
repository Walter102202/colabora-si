// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsagePanel, type UsageAgentRow, type UsageModelRow, type UsagePanelProps } from "@/components/agents/settings/UsagePanel";

const agent = (over: Partial<UsageAgentRow> = {}): UsageAgentRow => ({
  agentId: "a1",
  name: "Trama",
  harness: "managed",
  runs: 17,
  inputTokens: 612418,
  outputTokens: 9804,
  costUsd: 2.6481,
  estimated: false,
  monthlyBudgetUsd: 20,
  models: ["muse-wonder-1.0"],
  lastRunAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

const model = (over: Partial<UsageModelRow> = {}): UsageModelRow => ({
  model: "muse-wonder-1.0",
  runs: 14,
  inputTokens: 612418,
  outputTokens: 9804,
  costUsd: 2.6457,
  inputUsdPerMtok: 4,
  outputUsdPerMtok: 20,
  usdPerMinute: null,
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

const base = (over: Partial<UsagePanelProps> = {}): UsagePanelProps => ({
  period: "month",
  onPeriodChange: vi.fn(),
  state: "ready",
  agents: [agent()],
  models: [model()],
  totals: { runs: 17, inputTokens: 612418, outputTokens: 9804, costUsd: 2.6481 },
  onRefresh: vi.fn(),
  ...over,
});
const render = (props: UsagePanelProps) => act(() => root.render(createElement(UsagePanel, props)));
const rows = (table: number) => [...container.querySelectorAll("table")[table].querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent));

describe("UsagePanel", () => {
  it("renders the header, captions and columns", () => {
    render(base());
    expect(container.querySelector("h3")?.textContent).toBe("Usage");
    expect(container.textContent).toContain("Which model did the work, and what it cost. Read from every run; totals are exact.");
    expect([...container.querySelectorAll("caption")].map((c) => c.textContent)).toEqual(["Agents", "By model"]);
    expect([...container.querySelectorAll("table")[0].querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Agent", "Models", "Runs", "In", "Out", "Cost", "Budget", "Last run"]);
    expect([...container.querySelectorAll("table")[1].querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Model", "Runs", "In", "Out", "Cost", "Price"]);
    expect(container.querySelector("label")?.textContent).toContain("Period");
    expect(container.querySelector("select")?.value).toBe("month");
  });

  it("calls onPeriodChange and onRefresh", () => {
    const props = base();
    render(props);
    const select = container.querySelector("select")!;
    act(() => {
      select.value = "30d";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onPeriodChange).toHaveBeenCalledWith("30d");
    const refresh = [...container.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!;
    act(() => refresh.click());
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows loading and keeps the tables when data is present", () => {
    render(base({ state: "loading" }));
    expect(container.textContent).toContain("Loading usage…");
    expect(container.querySelectorAll("table")).toHaveLength(2);
  });

  it("shows the error message", () => {
    render(base({ state: "error", errorMessage: "Could not load usage.", agents: [], models: [], totals: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
    expect(container.textContent).toContain("Could not load usage.");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Refresh")).toBe(true);
  });

  it("shows the empty state when agents is empty or totals.runs is 0", () => {
    render(base({ agents: [], models: [], totals: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
    expect(container.textContent).toContain("No runs in this period.");
    expect(container.querySelector("table")).toBeNull();
    render(base({ agents: [agent({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastRunAt: null })], totals: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
    expect(container.textContent).toContain("No runs in this period.");
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders two agents and two models with labels, totals and budget", () => {
    const onOpenAgent = vi.fn();
    render(base({
      onOpenAgent,
      agents: [
        agent(),
        agent({ agentId: "a2", name: "Codex worker", harness: "codex", runs: 12, inputTokens: 0, outputTokens: 0, costUsd: 0, monthlyBudgetUsd: null, models: ["unknown"], lastRunAt: new Date(Date.now() - 26 * 3600_000).toISOString() }),
      ],
      models: [
        model(),
        model({ model: "muse-voice-transcribe-1.0", runs: 3, inputTokens: 0, outputTokens: 0, costUsd: 0.0024, inputUsdPerMtok: 0, outputUsdPerMtok: 0, usdPerMinute: 0.003 }),
      ],
      totals: { runs: 29, inputTokens: 612418, outputTokens: 9804, costUsd: 2.6481 },
    }));
    const agents = rows(0);
    expect(agents[0][0]).toContain("Trama");
    expect(agents[0][0]).toContain("managed");
    expect(agents[0][1]).toBe("Muse Wonder 1.0");
    expect(agents[0][3]).toBe("612.4k");
    expect(agents[0][5]).toBe("$2.65");
    expect(agents[0][6]).toContain("$2.65 of $20");
    expect(agents[0][7]).toBe("5m ago");
    expect(agents[1][1]).toBe("Not reported by harness");
    expect(agents[1][3]).toBe("—");
    expect(agents[1][4]).toBe("—");
    expect(agents[1][5]).toBe("—");
    expect(agents[1][6]).toBe("—");
    expect(agents[1][7]).toBe("Yesterday");
    const progress = container.querySelector("progress")!;
    expect(progress.getAttribute("aria-label")).toBe("Budget used");
    expect(progress.value).toBeCloseTo(2.6481);
    expect(progress.max).toBe(20);
    const total = [...container.querySelectorAll("table")[0].querySelectorAll("tfoot td")].map((c) => c.textContent);
    expect(total[0]).toBe("Total");
    expect(total[2]).toBe("29");
    const models = rows(1);
    expect(models[0][0]).toContain("Muse Wonder 1.0");
    expect(models[0][0]).toContain("Meta");
    expect(models[0][5]).toBe("$4 / $20 per M");
    expect(models[1][0]).toContain("Muse Voice Transcribe 1.0");
    expect(models[1][2]).toBe("—");
    expect(models[1][3]).toBe("—");
    expect(models[1][5]).toBe("$0.003 per minute of audio");
    const nameButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Trama"))!;
    act(() => nameButton.click());
    expect(onOpenAgent).toHaveBeenCalledWith("a1");
  });

  it("covers estimated cost, no models, zero runs and fractional prices", () => {
    render(base({
      agents: [agent({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, monthlyBudgetUsd: null, models: [], lastRunAt: null })],
      models: [model({ model: "unknown", runs: 2, inputTokens: 0, outputTokens: 0, costUsd: 0, inputUsdPerMtok: null, outputUsdPerMtok: null })],
      totals: { runs: 2, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }));
    // totals.runs > 0, so tables render even though this agent has zero runs.
    const agents = rows(0);
    expect(agents[0][1]).toBe("—");
    expect(agents[0][3]).toBe("0");
    expect(agents[0][4]).toBe("0");
    expect(agents[0][5]).toBe("$0.00");
    expect(agents[0][7]).toBe("—");
    const models = rows(1);
    expect(models[0][0]).toBe("Not reported by harness");
    expect(models[0][5]).toBe("—");
    render(base({ models: [model({ inputUsdPerMtok: 0.6, outputUsdPerMtok: 2.4 })] }));
    expect(rows(1)[0][5]).toBe("$0.60 / $2.40 per M");
    render(base({ agents: [agent({ estimated: true })] }));
    expect(rows(0)[0][5]).toBe("$2.65 est.");
  });
});
