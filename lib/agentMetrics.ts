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

// Why a metric has no number, when the reason tells the person more than "not measured".
const NOT_MEASURED: Record<string, string> = {
  owners_only: "Owners only",
  per_agent_only: "Counted per agent in Settings",
  webhook_agent: "Not logged for webhook agents",
};

export function formatMetric(m: Metric): string {
  // Nothing measured never reads as 0.
  if (m.status === "not_measured") return (m.reason && NOT_MEASURED[m.reason]) || "Not measured yet";
  if (m.status !== "measured" || m.value === null) return m.reason === "cost_unreported" ? "No cost reported" : "No data yet";
  switch (m.unit) {
    case "s": {
      const seconds = Math.round(m.value);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const rest = seconds % 60;
      return [hours && `${hours} h`, minutes && `${minutes} min`, rest && `${rest} s`].filter(Boolean).join(" ") || "0 s";
    }
    case "usd": {
      const small = m.value > 0 && m.value < 0.01;
      // Some runs reported no cost: the sum of the others is a lower bound.
      if (m.reason === "cost_partial") return `At least $${small ? Number(m.value.toFixed(4)) : m.value.toFixed(2)}`;
      return small ? "<$0.01" : `$${m.value.toFixed(2)}`;
    }
    case "per_deliverable": return String(Number(m.value.toFixed(2)));
    case "tasks":
    case "ops": return `${m.value} of ${m.sample}`;
    default: return String(m.value);
  }
}
