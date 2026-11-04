import type { ReactNode } from "react";
import { formatTokens, formatUsd } from "@/lib/agentFormat";
import { modelInfo } from "@/lib/agentModelLabel";

export type UsagePeriod = "month" | "30d";
export interface UsageAgentRow { agentId: string; name: string; harness: string | null; runs: number; inputTokens: number; outputTokens: number; costUsd: number; estimated: boolean; monthlyBudgetUsd: number | null; models: string[]; lastRunAt: string | null }
export interface UsageModelRow { model: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number; inputUsdPerMtok: number | null; outputUsdPerMtok: number | null; usdPerMinute: number | null }
export interface UsageTotals { runs: number; inputTokens: number; outputTokens: number; costUsd: number }
export interface UsagePanelProps { period: UsagePeriod; onPeriodChange(period: UsagePeriod): void; state: "loading" | "ready" | "error"; errorMessage?: string; agents: UsageAgentRow[]; models: UsageModelRow[]; totals: UsageTotals; onRefresh(): void; onOpenAgent?(agentId: string): void }

const NUM = "text-right tabular-nums";
const HEAD = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-text-tertiary";
const CELL = "px-2 py-1.5";
const DASH = <span className="text-text-tertiary">—</span>;

function exactTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function exactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${String(Number(n.toFixed(6)))}`;
}

function isNotReported(id: string): boolean {
  return !id || id === "unknown";
}

function hasReportedModel(models: string[]): boolean {
  return models.some((id) => !isNotReported(id));
}

function dashedNumbers(runs: number, inputTokens: number, outputTokens: number, costUsd: number, reported: boolean): boolean {
  return runs > 0 && inputTokens === 0 && outputTokens === 0 && costUsd === 0 && !reported;
}

function TokenCell({ value, dashed }: { value: number; dashed: boolean }) {
  if (dashed) return DASH;
  return <span title={exactTokens(value)}>{formatTokens(value)}</span>;
}

function CostCell({ value, dashed, estimated = false }: { value: number; dashed: boolean; estimated?: boolean }) {
  if (dashed) return DASH;
  const title = estimated ? `${exactUsd(value)}, estimated` : exactUsd(value);
  return <span title={title}>{formatUsd(value)}{estimated ? " est." : ""}</span>;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diff / 3600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function priceAmount(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function budgetAmount(n: number): string {
  return Number.isInteger(n) ? `$${n}` : formatUsd(n);
}

function ModelLabel({ id }: { id: string }) {
  if (isNotReported(id)) return <span className="text-text-tertiary">Not reported by harness</span>;
  const info = modelInfo(id);
  return (
    <>
      <span title={info.id}>{info.label}</span>
      {info.provider === "Meta" ? <span className="text-[11px] text-text-tertiary"> Meta</span> : null}
    </>
  );
}

function AgentModels({ models }: { models: string[] }) {
  if (models.length === 0) return DASH;
  const parts: ReactNode[] = [];
  models.forEach((id, i) => {
    if (i > 0) parts.push(", ");
    if (isNotReported(id)) {
      parts.push(<span key={`${id}-${i}`} className="text-text-tertiary">Not reported by harness</span>);
    } else {
      const info = modelInfo(id);
      parts.push(<span key={`${id}-${i}`} title={info.id}>{info.label}</span>);
    }
  });
  return <>{parts}</>;
}

export function UsagePanel({ period, onPeriodChange, state, errorMessage, agents, models, totals, onRefresh, onOpenAgent }: UsagePanelProps) {
  const empty = state === "ready" && (agents.length === 0 || totals.runs === 0);
  const showTables = !empty && state !== "error" && (agents.length > 0 || models.length > 0);
  return (
    <section aria-label="Usage" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Usage</h3>
          <p className="mt-0.5 text-xs text-text-tertiary">Which model did the work, and what it cost. Read from every run; totals are exact.</p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="usage-period" className="text-xs">Period</label>
          <select
            id="usage-period"
            className="rounded border border-border bg-bg px-2 py-1 text-xs"
            value={period}
            onChange={(e) => onPeriodChange(e.target.value as UsagePeriod)}
          >
            <option value="month">This month (UTC)</option>
            <option value="30d">Last 30 days</option>
          </select>
          <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={onRefresh}>Refresh</button>
        </div>
      </div>

      {state === "loading" ? <p className="text-xs text-text-tertiary">Loading usage…</p> : null}
      {state === "error" ? <p role="alert" className="text-xs text-red-700 dark:text-red-400">{errorMessage ?? "Could not load usage."}</p> : null}
      {empty ? <p className="text-xs text-text-tertiary">No runs in this period.</p> : null}

      {showTables ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="pb-1.5 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary">Agents</caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD}>Agent</th>
                  <th scope="col" className={HEAD}>Models</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>Runs</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>In</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>Out</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>Cost</th>
                  <th scope="col" className={HEAD}>Budget</th>
                  <th scope="col" className={HEAD}>Last run</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((row) => {
                  const dashed = dashedNumbers(row.runs, row.inputTokens, row.outputTokens, row.costUsd, hasReportedModel(row.models));
                  return (
                    <tr key={row.agentId} className="border-b border-border">
                      <td className={CELL}>
                        {onOpenAgent ? (
                          <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpenAgent(row.agentId)}>
                            {row.name}
                            {row.harness ? <span className="block text-[11px] font-normal text-text-tertiary">{row.harness}</span> : null}
                          </button>
                        ) : (
                          <>
                            <span className="font-medium">{row.name}</span>
                            {row.harness ? <span className="block text-[11px] text-text-tertiary">{row.harness}</span> : null}
                          </>
                        )}
                      </td>
                      <td className={CELL}><AgentModels models={row.models} /></td>
                      <td className={`${CELL} ${NUM}`}>{row.runs}</td>
                      <td className={`${CELL} ${NUM}`}><TokenCell value={row.inputTokens} dashed={dashed} /></td>
                      <td className={`${CELL} ${NUM}`}><TokenCell value={row.outputTokens} dashed={dashed} /></td>
                      <td className={`${CELL} ${NUM}`}><CostCell value={row.costUsd} dashed={dashed} estimated={row.estimated} /></td>
                      <td className={CELL}>
                        {row.monthlyBudgetUsd === null ? DASH : (
                          <span className="flex items-center gap-2">
                            <progress value={row.costUsd} max={row.monthlyBudgetUsd} aria-label="Budget used" />
                            <span className="text-[11px] text-text-tertiary">{formatUsd(row.costUsd)} of {budgetAmount(row.monthlyBudgetUsd)}</span>
                          </span>
                        )}
                      </td>
                      <td className={`${CELL} text-text-tertiary`}>
                        {row.lastRunAt ? <span title={row.lastRunAt}>{relativeTime(row.lastRunAt)}</span> : DASH}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className={CELL}>Total</td>
                  <td className={CELL} />
                  <td className={`${CELL} ${NUM}`}>{totals.runs}</td>
                  <td className={`${CELL} ${NUM}`}><span title={exactTokens(totals.inputTokens)}>{formatTokens(totals.inputTokens)}</span></td>
                  <td className={`${CELL} ${NUM}`}><span title={exactTokens(totals.outputTokens)}>{formatTokens(totals.outputTokens)}</span></td>
                  <td className={`${CELL} ${NUM}`}><span title={exactUsd(totals.costUsd)}>{formatUsd(totals.costUsd)}</span></td>
                  <td className={CELL} />
                  <td className={CELL} />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="pb-1.5 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary">By model</caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD}>Model</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>Runs</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>In</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>Out</th>
                  <th scope="col" className={`${HEAD} ${NUM}`}>Cost</th>
                  <th scope="col" className={HEAD}>Price</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => {
                  const notReported = isNotReported(row.model);
                  const info = notReported ? null : modelInfo(row.model);
                  const voice = info?.kind === "voice";
                  const dashed = dashedNumbers(row.runs, row.inputTokens, row.outputTokens, row.costUsd, !notReported);
                  return (
                    <tr key={row.model || "unknown"} className="border-b border-border">
                      <td className={CELL}><ModelLabel id={row.model} /></td>
                      <td className={`${CELL} ${NUM}`}>{row.runs}</td>
                      <td className={`${CELL} ${NUM}`}><TokenCell value={row.inputTokens} dashed={dashed || voice} /></td>
                      <td className={`${CELL} ${NUM}`}><TokenCell value={row.outputTokens} dashed={dashed || voice} /></td>
                      <td className={`${CELL} ${NUM}`}><CostCell value={row.costUsd} dashed={dashed} /></td>
                      <td className={`${CELL} text-text-tertiary`}>
                        {notReported || (row.usdPerMinute === null && (row.inputUsdPerMtok === null || row.outputUsdPerMtok === null))
                          ? DASH
                          : row.usdPerMinute !== null
                            ? `$${String(Number(row.usdPerMinute.toFixed(6)))} per minute of audio`
                            : `${priceAmount(row.inputUsdPerMtok!)} / ${priceAmount(row.outputUsdPerMtok!)} per M`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
