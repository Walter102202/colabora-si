// Metrics of how agents work for people (migration 0021). The server measures; this module names and formats.
export interface Metric {
  key: string;
  status: "measured" | "no_data" | "not_measured";
  value: number | null;
  unit: string;
  sample: number;
  reason: string | null;
}

export interface MetricsResult { tasks: number; metrics: Metric[] }

export const METRIC_LABEL: Record<string, string> = {
  interventions_per_accepted: "Interventions per accepted deliverable",
  decision_latency_s: "Time to your decision",
  reverted_after_accept: "Reverted after acceptance",
  time_to_first_signal_s: "Time to first signal",
  repeated_corrections: "Repeated corrections",
  resume_time_s: "Time to resume after a handover",
  duplicate_effects: "Duplicated external effects",
  cost_per_accepted_usd: "Cost per accepted deliverable",
  stale_knowledge_answers: "Answers from stale sources",
  out_of_scope_attempts: "Denied tool calls",
};

export function formatMetric(m: Metric): string {
  // Nothing measured never reads as 0.
  if (m.status === "not_measured") return "Not measured yet";
  if (m.status !== "measured" || m.value === null) return "No data yet";
  switch (m.unit) {
    case "s": {
      const seconds = Math.round(m.value);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const rest = seconds % 60;
      return [hours && `${hours} h`, minutes && `${minutes} min`, rest && `${rest} s`].filter(Boolean).join(" ") || "0 s";
    }
    case "usd": return `$${m.value.toFixed(2)}`;
    case "per_deliverable": return String(Number(m.value.toFixed(2)));
    case "tasks":
    case "ops": return `${m.value} of ${m.sample}`;
    default: return String(m.value);
  }
}
