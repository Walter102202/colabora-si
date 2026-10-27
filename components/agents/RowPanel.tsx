"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import {
  activeRunFor,
  currentArtifactFor,
  currentBriefFor,
  latestReviewFor,
  pendingApprovalFor,
  taskForPage,
  useAgentTasks,
  type TaskRow,
} from "@/lib/agentTasks";
import { RUN_STATUS_LABEL, acceptanceLabel, isTerminal, whatWillHappen } from "@/lib/agentState";
import { briefFromRow, closeTask, createTask, decideApproval, sendMessage, type ApprovalDecision } from "@/lib/agentActions";
import { StatusBadge } from "@/components/agents/AgentPropertyCell";
import { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
import { DecisionCard } from "@/components/agents/panel/DecisionCard";
import { LeadReviewCard } from "@/components/agents/panel/LeadReviewCard";
import { SubtaskList } from "@/components/agents/panel/SubtaskList";
import { ActivityTimeline, activityLabel } from "@/components/agents/panel/ActivityTimeline";
import { FeedbackComposer } from "@/components/agents/panel/FeedbackComposer";
import { formatRelative } from "@/lib/utils";

// Agent layer plug. Mounted by the page view of a database row, under the row
// properties (also reached through the `?task=` deep link). The whole
// conversation between the person and the agent about this row.
export interface RowPanelProps {
  pageId: string;
}

export function RowPanel({ pageId }: RowPanelProps) {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const loadAgents = useAgentsStore((s) => s.load);
  const task = useAgentTasks((s) => taskForPage(s, pageId));

  useEffect(() => {
    if (!workspaceId) return;
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [workspaceId, subscribe, loadAgents]);

  if (!workspaceId) {
    return (
      <section className="mt-6 rounded-md border border-border p-3 text-sm text-text-secondary" aria-label="Agent task">
        No connection. Agents need you to sign in.
      </section>
    );
  }
  return (
    <section className="mt-6 space-y-4 rounded-md border border-border p-3 text-sm" aria-label="Agent task">
      {task ? <TaskPanel task={task} /> : <AssignCard pageId={pageId} />}
    </section>
  );
}

function AssignCard({ pageId }: { pageId: string }) {
  const agents = useAgentsStore((s) => s.agents);
  const enabled = useMemo(() => agents.filter((a) => a.status === "enabled"), [agents]);
  const [agentId, setAgentId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = enabled.find((a) => a.id === agentId) ?? null;
  const preview = agent ? whatWillHappen({ state: "queued", brief_version: 1 }, { name: agent.name, capabilities: agent.capabilities }, "continue") : null;

  const assign = async () => {
    setBusy(true);
    setError(null);
    try {
      const brief = briefFromRow(pageId);
      if (note.trim()) brief.next_step = note.trim();
      await createTask(pageId, brief, agentId || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="font-medium">Hand this row to an agent</h3>
      <p className="text-xs text-text-secondary">The title becomes the objective and the “Done when” cell the acceptance criteria. You can refine the brief afterwards.</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded border border-border bg-bg px-2 py-1" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
          <option value="">No agent yet (queued)</option>
          {enabled.map((a) => (
            <option key={a.id} value={a.id}>{a.name}{a.role === "lead" ? " (Lead)" : ""}</option>
          ))}
        </select>
        {enabled.length === 0 && <span className="text-xs text-text-tertiary">Register an agent in Settings → Agents.</span>}
      </div>
      <textarea className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" rows={2} placeholder="First step or extra instructions (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {preview && <p className="text-xs text-text-tertiary">{preview}</p>}
      {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <button type="button" className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50" disabled={busy} onClick={() => void assign()}>
        {busy ? "Saving…" : "Save and assign"}
      </button>
    </div>
  );
}

function TaskPanel({ task }: { task: TaskRow }) {
  const agents = useAgentsStore((s) => s.agents);
  const run = useAgentTasks((s) => activeRunFor(s, task));
  const approval = useAgentTasks((s) => pendingApprovalFor(s, task.id));
  const artifact = useAgentTasks((s) => currentArtifactFor(s, task.id));
  const review = useAgentTasks((s) => latestReviewFor(s, task.id));
  const brief = useAgentTasks((s) => currentBriefFor(s, task));
  const activities = useAgentTasks((s) => s.activities[task.id]);
  const loadBriefs = useAgentTasks((s) => s.loadBriefs);
  const loadActivities = useAgentTasks((s) => s.loadActivities);
  const [showTimeline, setShowTimeline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<"accepted" | "rejected" | null>(null);
  const [closeNote, setCloseNote] = useState("");

  const agent = agents.find((a) => a.id === task.delegate_agent_id) ?? null;
  const agentLike = agent ? { name: agent.name, capabilities: agent.capabilities } : null;
  const terminal = isTerminal(task.state);

  useEffect(() => {
    void loadBriefs(task.id);
  }, [task.id, task.brief_version, loadBriefs]);
  useEffect(() => {
    void loadActivities(task.id);
  }, [task.id, task.last_activity_at, loadActivities]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const recentActions = (activities ?? []).filter((a) => a.type === "action").slice(-3);
  const nextText = whatWillHappen(task, agentLike, "continue", { artifactVersion: artifact?.version ?? null });
  const onDecide = (decision: ApprovalDecision, response: Record<string, unknown> | null) =>
    approval ? decideApproval(approval.id, decision, response).then(() => undefined) : Promise.resolve();

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge task={task} run={run} agentName={agent?.name ?? null} />
        <span className="text-xs text-text-secondary">{agent ? agent.name : "No agent assigned"}{agent?.role === "lead" ? " · Lead" : ""}</span>
        {run && <span className="text-xs text-text-tertiary">Run {RUN_STATUS_LABEL[run.status].toLowerCase()} · {formatRelative(Date.parse(run.last_signal_at))}</span>}
        <span className="text-xs text-text-tertiary">Brief v{task.brief_version}{task.brief_stale ? " · pending re-run" : ""}</span>
        {task.cost_usd > 0 && <span className="text-xs text-text-tertiary">${task.cost_usd.toFixed(4)}</span>}
        {task.state === "done" && <span className="text-xs text-text-tertiary">{acceptanceLabel(task.acceptance)}</span>}
      </header>

      {error && <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">{error}</p>}

      <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">What was asked and what changed</h4>
        <p>{brief?.objective ?? task.title ?? "Loading brief…"}</p>
        {brief?.next_step && <p className="text-xs text-text-secondary">Next step: {brief.next_step}</p>}
        {recentActions.length > 0 ? (
          <ul className="text-xs text-text-secondary">
            {recentActions.map((a) => (
              <li key={a.id}>· {activityLabel(a)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-tertiary">Nothing changed yet.</p>
        )}
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Deliverable</h4>
        {artifact ? (
          <p className="text-xs">
            v{artifact.version} · {artifact.kind}{" "}
            {artifact.kind === "page" ? (
              <a className="text-accent underline" href={`/p/${encodeURIComponent(artifact.ref)}`}>{artifact.title || "page"}</a>
            ) : /^https?:\/\//.test(artifact.ref) ? (
              <a className="text-accent underline" href={artifact.ref} target="_blank" rel="noreferrer noopener">{artifact.title || artifact.ref}</a>
            ) : (
              <span>{artifact.title || artifact.ref}</span>
            )}
            {artifact.satisfies.length > 0 && <span className="text-text-tertiary"> · covers {artifact.satisfies.join(", ")}</span>}
          </p>
        ) : (
          <p className="text-xs text-text-tertiary">No deliverable yet.</p>
        )}
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Verification</h4>
        <LeadReviewCard
          task={task}
          review={review}
          brief={brief}
          artifact={artifact}
          reviewerName={review ? (agents.find((a) => a.id === review.reviewer_id)?.name ?? null) : null}
        />
      </section>

      <SubtaskList parentId={task.id} />

      {approval && (approval.kind === "action" ? <ApprovalCard approval={approval} onDecide={onDecide} /> : <DecisionCard approval={approval} onDecide={onDecide} />)}

      {!terminal && !approval && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">What will happen</h4>
          <p className="text-xs text-text-secondary">{nextText}</p>
        </section>
      )}

      <FeedbackComposer
        disabled={busy !== null || task.state === "failed"}
        placeholder={terminal ? "Tell the agent what to do next; sending reopens the task…" : undefined}
        onSend={(text) => act("send", () => sendMessage(task.id, text, terminal ? "continue" : "feedback"))}
      />

      <div className="flex flex-wrap gap-2">
        {!terminal && (
          <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" title={nextText} disabled={busy !== null} onClick={() => act("continue", () => sendMessage(task.id, "", "continue"))}>
            Continue
          </button>
        )}
        {!terminal && (
          <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" title={whatWillHappen(task, agentLike, "stop")} disabled={busy !== null || !!run?.stop_requested_at} onClick={() => act("stop", () => sendMessage(task.id, "", "stop"))}>
            {run?.stop_requested_at ? "Stopping…" : "Stop"}
          </button>
        )}
        {(task.state === "ready_for_review" || task.state === "input_required") && !closing && (
          <>
            <button type="button" className="rounded border border-green-600/50 px-3 py-1 text-xs text-green-700 hover:bg-bg-secondary dark:text-green-400" disabled={busy !== null || task.state !== "ready_for_review"} onClick={() => setClosing("accepted")}>
              Accept and close
            </button>
            <button type="button" className="rounded border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-secondary" disabled={busy !== null} onClick={() => setClosing("rejected")}>
              Close without accepting
            </button>
          </>
        )}
        {terminal && (
          <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" title={whatWillHappen(task, agentLike, "continue")} disabled={busy !== null} onClick={() => act("reopen", () => sendMessage(task.id, "", "continue"))}>
            Reopen
          </button>
        )}
        <button type="button" className="ml-auto rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-secondary" onClick={() => setShowTimeline((v) => !v)}>
          {showTimeline ? "Hide timeline" : "Show timeline"}
        </button>
      </div>

      {closing && (
        <div className="space-y-1 rounded-md border border-border p-2">
          <p className="text-xs">{closing === "accepted" ? "Accept the deliverable and close the task." : "Close the task without accepting the deliverable."} Nothing is reverted.</p>
          <input className="w-full rounded border border-border bg-bg px-2 py-1 text-xs" placeholder="Note (optional)" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy !== null} onClick={() => act("close", () => closeTask(task.id, closing, closeNote.trim() || null).then(() => setClosing(null)))}>
              Confirm
            </button>
            <button type="button" className="rounded px-3 py-1 text-xs text-text-secondary hover:bg-bg-secondary" onClick={() => setClosing(null)}>Keep open</button>
          </div>
        </div>
      )}

      {showTimeline && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Timeline</h4>
          <ActivityTimeline activities={activities ?? []} />
        </section>
      )}
    </div>
  );
}
