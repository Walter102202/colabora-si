import { METRIC_LABEL, formatMetric, type Metric } from "@/lib/agentMetrics";

export interface MetricsListProps { title: string; metrics: Metric[] }

export function MetricsList({ title, metrics }: MetricsListProps) {
  return (
    <section aria-label={title} className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{title}</h4>
      <dl className="space-y-1 text-xs">
        {metrics.map((m) => (
          <div key={m.key} className="flex justify-between gap-4">
            <dt className="text-text-secondary">{METRIC_LABEL[m.key] ?? m.key}</dt>
            <dd className={m.status === "measured" ? "text-right" : "text-right text-text-tertiary"}>{formatMetric(m)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
