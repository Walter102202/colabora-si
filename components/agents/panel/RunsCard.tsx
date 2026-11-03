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
const HEAD = "text-left text-[11px] font-medium uppercase tracking-wide text-text-tertiary";

function exactTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function exactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${String(Number(n.toFixed(4)))}`;
}

function CostCell({ run }: { run: RunsCardRun }) {
  if (run.costKind === "unknown" && run.costUsd === 0) return <span className="text-text-tertiary">—</span>;
  const title = run.costKind === "estimated" ? `${exactUsd(run.costUsd)}, estimated` : exactUsd(run.costUsd);
  return <span title={title}>{formatUsd(run.costUsd)}{run.costKind === "estimated" ? " est." : ""}</span>;
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
  const anyEstimated = runs.some((r) => r.costKind === "estimated");
  return (
    <section aria-label="Runs & cost" className="space-y-2">
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
                <tr>
                  <td>{run.agentName ?? run.harness}</td>
                  <td>
                    {info ? (
                      <>
                        <span title={info.id}>{info.label}</span>
                        {info.provider === "Meta" ? <span className="text-[11px] text-text-tertiary"> Meta</span> : null}
                      </>
                    ) : (
                      <span className="text-text-tertiary">Not reported by harness</span>
                    )}
                  </td>
                  <td>{STATUS_LABEL[run.status] ?? run.status}</td>
                  <td className={NUM}><TokenCell value={run.inputTokens} dashed={noTokens} /></td>
                  <td className={NUM}><TokenCell value={run.outputTokens} dashed={noTokens} /></td>
                  <td className={NUM}><CostCell run={run} /></td>
                  <td className={run.endedAt === null ? `${NUM} text-text-tertiary` : NUM}>{duration}</td>
                </tr>
                {run.errorMessage ? (
                  <tr>
                    <td colSpan={7} className="text-[11px] text-text-tertiary">{run.errorMessage}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td>Total</td>
            <td />
            <td />
            <td className={NUM}><span title={exactTokens(totalIn)}>{formatTokens(totalIn)}</span></td>
            <td className={NUM}><span title={exactTokens(totalOut)}>{formatTokens(totalOut)}</span></td>
            <td className={NUM}>
              <span title={anyEstimated ? `${exactUsd(totalCost)}, part estimated` : exactUsd(totalCost)}>
                {formatUsd(totalCost)}{anyEstimated ? " est." : ""}
              </span>
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
