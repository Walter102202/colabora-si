import { Fragment } from "react";
import { formatDuration, formatTokens, formatUsd } from "@/lib/agentFormat";
import { modelInfo } from "@/lib/agentModelLabel";

export interface RunsCardRun { id: string; agentName: string | null; harness: string; model: string | null; status: string; inputTokens: number; outputTokens: number; costUsd: number; costKind: "measured" | "estimated" | "unknown"; startedAt: string; endedAt: string | null; errorMessage: string | null }

export interface RunsCardProps { runs: RunsCardRun[] }

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  waiting: "Waiting",
  completed: "Ended",
  error: "Failed",
  cancelled: "Cancelled",
};

const NUM = "text-right tabular-nums";
const HEAD = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-text-tertiary";
const CELL = "px-2 py-1.5";

function exactTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function exactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${String(Number(n.toFixed(6)))}`;
}

function isEstimated(run: RunsCardRun): boolean {
  return run.costKind === "estimated" || (run.costKind !== "measured" && run.costUsd > 0);
}

function isCostDashed(run: RunsCardRun): boolean {
  return run.costKind === "unknown" && run.costUsd === 0;
}

function CostCell({ run }: { run: RunsCardRun }) {
  if (isCostDashed(run)) return <span className="text-text-tertiary">—</span>;
  const estimated = isEstimated(run);
  const title = estimated ? `${exactUsd(run.costUsd)}, estimated` : exactUsd(run.costUsd);
  return <span title={title}>{formatUsd(run.costUsd)}{estimated ? " est." : ""}</span>;
}

function TokenCell({ value, dashed }: { value: number; dashed: boolean }) {
  if (dashed) return <span className="text-text-tertiary">—</span>;
  return <span title={exactTokens(value)}>{formatTokens(value)}</span>;
}

export function RunsCard({ runs }: RunsCardProps) {
  if (runs.length === 0) {
    return (
      <section aria-label="Runs & cost" className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Runs &amp; cost</h4>
        <p className="text-xs text-text-tertiary">No runs yet.</p>
      </section>
    );
  }
  const totalIn = runs.reduce((sum, r) => sum + (Number.isFinite(r.inputTokens) ? r.inputTokens : 0), 0);
  const totalOut = runs.reduce((sum, r) => sum + (Number.isFinite(r.outputTokens) ? r.outputTokens : 0), 0);
  const totalCost = runs.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
  const anyEstimated = runs.some(isEstimated);
  const allTokensDashed = runs.every((r) => !r.model && r.inputTokens === 0 && r.outputTokens === 0);
  const allCostDashed = runs.every(isCostDashed);
  return (
    <section aria-label="Runs & cost" className="space-y-2">
      <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="pb-1.5 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary">Runs &amp; cost</caption>
        <thead>
          <tr>
            <th scope="col" className={HEAD}>Agent</th>
            <th scope="col" className={HEAD}>Model</th>
            <th scope="col" className={HEAD}>Status</th>
            <th scope="col" className={`${HEAD} ${NUM}`}>In</th>
            <th scope="col" className={`${HEAD} ${NUM}`}>Out</th>
            <th scope="col" className={`${HEAD} ${NUM}`}>Cost</th>
            <th scope="col" className={`${HEAD} ${NUM}`}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const info = run.model ? modelInfo(run.model) : null;
            const noTokens = !run.model && run.inputTokens === 0 && run.outputTokens === 0;
            const duration = run.endedAt === null ? "running" : formatDuration(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime());
            return (
              <Fragment key={run.id}>
                <tr className="border-b border-border">
                  <td className={CELL}>{run.agentName ?? run.harness}</td>
                  <td className={CELL}>
                    {info ? (
                      <>
                        <span title={info.id}>{info.label}</span>
                        {info.provider === "Meta" ? <span className="text-[11px] text-text-tertiary"> Meta</span> : null}
                      </>
                    ) : (
                      <span className="text-text-tertiary">Not reported by harness</span>
                    )}
                  </td>
                  <td className={CELL}>{STATUS_LABEL[run.status] ?? run.status}</td>
                  <td className={`${CELL} ${NUM}`}><TokenCell value={run.inputTokens} dashed={noTokens} /></td>
                  <td className={`${CELL} ${NUM}`}><TokenCell value={run.outputTokens} dashed={noTokens} /></td>
                  <td className={`${CELL} ${NUM}`}><CostCell run={run} /></td>
                  <td className={run.endedAt === null ? `${CELL} ${NUM} text-text-tertiary` : `${CELL} ${NUM}`}>{duration}</td>
                </tr>
                {run.errorMessage ? (
                  <tr className="border-b border-border">
                    <td colSpan={7} className="px-2 pt-0 text-[11px] text-text-tertiary">{run.errorMessage}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-medium">
            <td className={CELL}>Total</td>
            <td className={CELL} />
            <td className={CELL} />
            <td className={`${CELL} ${NUM}`}>{allTokensDashed ? <span className="text-text-tertiary">—</span> : <span title={exactTokens(totalIn)}>{formatTokens(totalIn)}</span>}</td>
            <td className={`${CELL} ${NUM}`}>{allTokensDashed ? <span className="text-text-tertiary">—</span> : <span title={exactTokens(totalOut)}>{formatTokens(totalOut)}</span>}</td>
            <td className={`${CELL} ${NUM}`}>
              {allCostDashed ? (
                <span className="text-text-tertiary">—</span>
              ) : (
                <span title={anyEstimated ? `${exactUsd(totalCost)}, part estimated` : exactUsd(totalCost)}>
                  {formatUsd(totalCost)}{anyEstimated ? " est." : ""}
                </span>
              )}
            </td>
            <td className={CELL} />
          </tr>
        </tfoot>
      </table>
      </div>
    </section>
  );
}
