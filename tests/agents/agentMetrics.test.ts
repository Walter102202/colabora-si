// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { METRIC_LABEL, formatMetric, type Metric } from "@/lib/agentMetrics";
import { MetricsList, TaskView } from "@/components/agents/panel";
import { cardDataFrom, type TaskCardData } from "@/lib/agentCard";
import { mockCard } from "@/components/agents/card/mock";

const KEYS = ["interventions_per_accepted", "decision_latency_s", "reverted_after_accept", "time_to_first_signal_s", "repeated_corrections",
  "resume_time_s", "duplicate_effects", "cost_per_accepted_usd", "stale_knowledge_answers", "out_of_scope_attempts"];
const m = (key: string, over: Partial<Metric> = {}): Metric => ({ key, status: "measured", value: 1, unit: "s", sample: 1, reason: null, ...over });

describe("formatMetric", () => {
  it("formats each unit", () => {
    expect(formatMetric(m("decision_latency_s", { value: 45 }))).toBe("45 s");
    expect(formatMetric(m("decision_latency_s", { value: 90 }))).toBe("1 min 30 s");
    expect(formatMetric(m("resume_time_s", { value: 7500 }))).toBe("2 h 5 min");
    expect(formatMetric(m("cost_per_accepted_usd", { unit: "usd", value: 0.6 }))).toBe("$0.60");
    expect(formatMetric(m("interventions_per_accepted", { unit: "per_deliverable", value: 2.5 }))).toBe("2.5");
    expect(formatMetric(m("interventions_per_accepted", { unit: "per_deliverable", value: 3 }))).toBe("3");
    expect(formatMetric(m("reverted_after_accept", { unit: "tasks", value: 1, sample: 3 }))).toBe("1 of 3");
    expect(formatMetric(m("duplicate_effects", { unit: "ops", value: 1, sample: 4 }))).toBe("1 of 4");
    expect(formatMetric(m("out_of_scope_attempts", { unit: "attempts", value: 2 }))).toBe("2");
  });
  it("never shows 0 where there is nothing to measure", () => {
    expect(formatMetric(m("repeated_corrections", { status: "not_measured", value: 0 }))).toBe("Not measured yet");
    expect(formatMetric(m("interventions_per_accepted", { status: "no_data", value: null, sample: 0 }))).toBe("No data yet");
  });
  it("has a label for every metric the server returns", () => {
    for (const key of KEYS) expect(METRIC_LABEL[key]).toBeTruthy();
    expect(METRIC_LABEL.out_of_scope_attempts).toBe("Denied tool calls");
  });
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

describe("metrics views", () => {
  it("lists the ten metrics with their labels", () => {
    act(() => root.render(createElement(MetricsList, { title: "Results", metrics: KEYS.map((k) => m(k, { status: "no_data", value: null })) })));
    expect(container.querySelectorAll("dt")).toHaveLength(10);
    expect(container.querySelector("dt")?.textContent).toBe("Interventions per accepted deliverable");
    expect(container.textContent).not.toMatch(/\b0\b/);
  });
  it("shows Results in the task panel only when metrics are given", () => {
    const data = cardDataFrom(mockCard("side-question")) as TaskCardData;
    const props = { ...data, subtasks: [], reviewerName: null, agent: null, onMessage: async () => {}, onClose: async () => {},
      onDecide: async () => {}, onReview: async () => {}, onOpenTask: () => {}, onOpenPage: () => {} };
    act(() => root.render(createElement(TaskView, props)));
    expect(container.querySelector('section[aria-label="Results"]')).toBeNull();
    act(() => root.render(createElement(TaskView, { ...props, metrics: [m("decision_latency_s", { value: 90 })] })));
    expect(container.querySelector('section[aria-label="Results"]')?.textContent).toContain("1 min 30 s");
  });
});
