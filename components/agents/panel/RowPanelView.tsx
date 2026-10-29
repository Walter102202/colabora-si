import { autonomyLine, AUTONOMY_LABEL, AUTONOMY_LEVELS, type AutonomyLevel, type TaskAutonomy } from "@/lib/agentAutonomy";
import { useEffect, useId, useRef, useState } from "react";
import { continuityText, type ContinuityInfo } from "@/lib/agentContinuity";
import type { TaskDiff } from "@/lib/agentRunDiff";
import { RunDiffCard } from "@/components/agents/panel/RunDiffCard";
import { useQueuedChoice } from "@/components/agents/panel/useQueuedChoice";
import type { ActivityRow, ApprovalRow, ArtifactRow, BriefRow, ReviewRow, RunRow, TaskRow } from "@/lib/agentTasks";
import type { ApprovalDecision, MessageSignal } from "@/lib/agentActions";
import type { AgentRole } from "@/lib/agentsStore";
import { RUN_STATUS_LABEL, acceptanceLabel, isTerminal, whatWillHappen } from "@/lib/agentState";
import { formatRelative } from "@/lib/utils";
import { pageUrl } from "@/lib/routes";
import { StatusBadge } from "@/components/agents/panel/StatusBadge";
import { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
import { DecisionCard } from "@/components/agents/panel/DecisionCard";
import { LeadReviewCard, type ReviewFinding, type ReviewVerdict } from "@/components/agents/panel/LeadReviewCard";
import { SubtaskList, type SubtaskItem } from "@/components/agents/panel/SubtaskList";
import { ActivityTimeline } from "@/components/agents/panel/ActivityTimeline";
import { activityLabel } from "@/lib/agentTaskText";
import { FeedbackComposer } from "@/components/agents/panel/FeedbackComposer";
import { MetricsList } from "@/components/agents/panel/MetricsList";
import type { Metric } from "@/lib/agentMetrics";

// The row panel as pure views: everything a person sees and does about one
// task, driven by data and callbacks. No router, no stores, no network, so
// the same views can render inside the workspace or in an isolated root
// (an MCP App card in a chat, for instance).

export interface AgentOption {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: Record<string, boolean>;
}

export interface AssignViewProps {
  // Agents the person can hand the row to (already filtered to the enabled ones).
  agents: AgentOption[];
  // Creates the task from the row; `agentId` null queues it without an agent.
  onAssign: (agentId: string | null, note: string) => Promise<void>;
}

export interface TaskViewProps {
  task: TaskRow;
  agent: AgentOption | null;
  run: RunRow | null;
  approval: ApprovalRow | null;
  artifact: ArtifactRow | null;
  review: ReviewRow | null;
  brief: BriefRow | null;
  activities: ActivityRow[];
  subtasks: SubtaskItem[];
  reviewerName: string | null;
  // Results of the task and its subtasks (task_metrics); the chat card leaves them out.
  metrics?: Metric[] | null;
  // Whether the delegate can resume and its last checkpoint; null while unknown or without an agent.
  continuity?: ContinuityInfo | null;
  // The per-block diff of the task's runs; null when it does not apply or has not loaded.
  diff?: TaskDiff | null;
  // Reverts unchanged items of a finished run. Without it (the MCP card) the diff is read-only.
  onRevert?: (runId: string, keys: string[]) => Promise<void>;
  // Loads the diff again (a person may have edited a block since it loaded).
  onRefreshDiff?: () => Promise<void>;
  // Enabled agents to hand the task over to; the view leaves out the current delegate.
  handOverAgents?: AgentOption[];
  // Releases the task to another agent (null: the same agent, in a new session).
  onHandOver?: (toAgentId: string | null, note: string) => Promise<void>;
  // Approval a deep link (#approval-<id>) asked to land on, if any.
  focusApprovalId?: string | null;
  // The other pending questions, each answered by its own id: those asked with blocking false and those waiting behind `approval`.
  openQuestions?: ApprovalRow[];
  // What the task may do without asking; the select appears only with onSetAutonomy (not in the chat card).
  autonomy?: TaskAutonomy | null;
  onSetAutonomy?: (level: AutonomyLevel | null) => Promise<void>;
  onDecideQuestion?: (approvalId: string, decision: ApprovalDecision, response: Record<string, unknown> | null) => Promise<void>;
  // Message to the agent: text with "feedback"/"continue", or an empty body with "continue"/"stop".
  onMessage: (body: string, signal: MessageSignal) => Promise<void>;
  onClose: (acceptance: "accepted" | "rejected", note: string | null) => Promise<void>;
  onDecide: (decision: ApprovalDecision, response: Record<string, unknown> | null) => Promise<void>;
  onReview: (verdict: ReviewVerdict, findings: ReviewFinding[], artifactId: string | null) => Promise<void>;
  onOpenTask: (pageId: string, taskId: string) => void;
  onOpenPage: (pageId: string) => void;
}

export type RowPanelViewProps = ({ kind: "assign" } & AssignViewProps) | ({ kind: "task" } & TaskViewProps);

export function RowPanelView(props: RowPanelViewProps) {
  return props.kind === "task" ? <TaskView {...props} /> : <AssignView {...props} />;
}

export function AssignView({ agents, onAssign }: AssignViewProps) {
  const id = useId();
  const [agentId, setAgentId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId) ?? null;
  const preview = agent ? whatWillHappen({ state: "queued", brief_version: 1 }, { name: agent.name, capabilities: agent.capabilities }, "continue") : null;

  const assign = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAssign(agentId || null, note);
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
        <label htmlFor={`${id}-agent`} className="sr-only">Agent</label>
        <select id={`${id}-agent`} className="rounded border border-border bg-bg px-2 py-1" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">No agent yet (queued)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}{a.role === "lead" ? " (Lead)" : ""}</option>
          ))}
        </select>
        {agents.length === 0 && <span className="text-xs text-text-tertiary">Register an agent in Settings → Agents.</span>}
      </div>
      <label htmlFor={`${id}-note`} className="sr-only">First step or extra instructions</label>
      <textarea id={`${id}-note`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" rows={2} placeholder="First step or extra instructions (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {preview && <p className="text-xs text-text-tertiary">{preview}</p>}
      {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <button type="button" className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50" disabled={busy} onClick={() => void assign()}>
        {busy ? "Saving…" : "Save and assign"}
      </button>
    </div>
  );
}

export function TaskView({ task, agent, run, approval, artifact, review, brief, activities, subtasks, reviewerName, metrics = null, continuity = null, diff = null, onRevert, onRefreshDiff, handOverAgents = [], onHandOver, focusApprovalId = null, openQuestions = [], onDecideQuestion, autonomy = null, onSetAutonomy, onMessage, onClose, onDecide, onReview, onOpenTask, onOpenPage }: TaskViewProps) {
  const id = useId();
  const [showTimeline, setShowTimeline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<"accepted" | "rejected" | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [handingOver, setHandingOver] = useState(false);
  const [handoverAgent, setHandoverAgent] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [handoverError, setHandoverError] = useState<string | null>(null);
  const handOverToggle = useRef<HTMLButtonElement>(null);
  const refocusHandOver = useRef(false);
  const autonomyChoice = useQueuedChoice<AutonomyLevel | null>();

  const agentLike = agent ? { name: agent.name, capabilities: agent.capabilities } : null;
  const terminal = isTerminal(task.state);
  const handOverOthers = handOverAgents.filter((a) => a.id !== agent?.id);
  // Without a delegate there is no "same agent": the first other agent is preselected.
  const handoverTarget = handoverAgent || (agent ? "" : (handOverOthers[0]?.id ?? ""));

  // After a handover the form closes: the focus goes back to the button that opened it, once it is enabled again.
  useEffect(() => {
    if (refocusHandOver.current && busy === null) {
      refocusHandOver.current = false;
      handOverToggle.current?.focus();
    }
  });

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

  const handOver = async () => {
    if (!onHandOver) return;
    setBusy("handover");
    setHandoverError(null);
    try {
      await onHandOver(handoverTarget || null, handoverNote);
      setHandingOver(false);
      setHandoverAgent("");
      setHandoverNote("");
      refocusHandOver.current = true;
    } catch (e) {
      setHandoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const recentActions = activities.filter((a) => a.type === "action").slice(-3);
  const nextText = whatWillHappen(task, agentLike, "continue", { artifactVersion: artifact?.version ?? null });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge task={task} run={run} agentName={agent?.name ?? null} />
        <span className="text-xs text-text-secondary">{agent ? agent.name : "No agent assigned"}{agent?.role === "lead" ? " · Lead" : ""}</span>
        {run && <span className="text-xs text-text-tertiary">Run {RUN_STATUS_LABEL[run.status].toLowerCase()} · {formatRelative(Date.parse(run.last_signal_at))}</span>}
        <span className="text-xs text-text-tertiary">Brief v{task.brief_version}{task.brief_stale ? " · pending re-run" : ""}</span>
        {continuity && !terminal && <span className="text-xs text-text-tertiary">{continuityText(continuity)}</span>}
        {task.cost_usd > 0 && <span className="text-xs text-text-tertiary">${task.cost_usd.toFixed(4)}</span>}
        {task.state === "done" && <span className="text-xs text-text-tertiary">{acceptanceLabel(task.acceptance)}</span>}
      </header>

      {error && <p role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">{error}</p>}

      <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">What was asked and what changed</h4>
        <p>{brief?.objective ?? task.title ?? "Loading brief…"}</p>
        {brief?.next_step && <p className="text-xs text-text-secondary">Next step: {brief.next_step}</p>}
        {autonomy && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>{autonomyLine(autonomy)}</span>
            {onSetAutonomy && !terminal && (
              <>
                {/* A save in progress keeps it enabled, so the keyboard focus stays on it. */}
                <select aria-label="Autonomy for this task" className="rounded border border-border bg-bg px-1 py-0.5 text-xs disabled:opacity-50"
                  value={(autonomyChoice.pending ? autonomyChoice.pending.value : autonomy.requested) ?? ""}
                  disabled={autonomy.can_edit === false} aria-busy={autonomyChoice.busy}
                  aria-describedby={autonomy.can_edit === false ? `${id}-autonomy-owner` : undefined}
                  onChange={(e) => { const v = e.target.value; void autonomyChoice.choose(v ? (v as AutonomyLevel) : null, onSetAutonomy); }}>
                  <option value="">Workspace default ({AUTONOMY_LABEL[autonomy.workspace_level]})</option>
                  {AUTONOMY_LEVELS.map((l) => <option key={l} value={l}>{AUTONOMY_LABEL[l]}</option>)}
                </select>
                {autonomy.can_edit === false && <span id={`${id}-autonomy-owner`} className="text-text-tertiary">Only a workspace owner can change this.</span>}
              </>
            )}
            {autonomyChoice.error && <p role="alert" className="w-full text-red-700 dark:text-red-400">{autonomyChoice.error}</p>}
          </div>
        )}
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
              <a className="text-accent underline" href={pageUrl(artifact.ref)} onClick={(e) => { e.preventDefault(); onOpenPage(artifact.ref); }}>{artifact.title || "page"}</a>
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

      {diff && (diff.hidden_items > 0 || diff.runs.some((r) => r.items.length > 0)) && <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Changes</h4>
        <RunDiffCard diff={diff} onRevert={onRevert} onRefresh={onRefreshDiff} />
      </section>}

      <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Verification</h4>
        <LeadReviewCard task={task} review={review} brief={brief} artifact={artifact} reviewerName={reviewerName} onReview={onReview} />
      </section>

      <SubtaskList subtasks={subtasks} onOpenTask={onOpenTask} />

      {approval && (approval.kind === "action"
        ? <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} focus={focusApprovalId === approval.id} />
        : <DecisionCard key={approval.id} approval={approval} onDecide={onDecide} focus={focusApprovalId === approval.id} />)}

      {openQuestions.map((q) => (
        <DecisionCard key={q.id} approval={q} nonBlocking={q.blocking === false} focus={focusApprovalId === q.id}
          onDecide={(decision, response) => (onDecideQuestion ? onDecideQuestion(q.id, decision, response) : Promise.resolve())} />
      ))}

      {!terminal && !approval && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">What will happen</h4>
          <p className="text-xs text-text-secondary">{nextText}</p>
        </section>
      )}

      <FeedbackComposer
        disabled={busy !== null || task.state === "failed"}
        placeholder={terminal ? "Tell the agent what to do next; sending reopens the task…" : undefined}
        onSend={(text) => act("send", () => onMessage(text, terminal ? "continue" : "feedback"))}
      />

      <div className="flex flex-wrap gap-2">
        {!terminal && onHandOver && (
          <button
            ref={handOverToggle}
            type="button"
            className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50"
            disabled={busy !== null || task.state === "ready_for_review"}
            aria-expanded={handingOver}
            aria-controls={`${id}-handover`}
            title={task.state === "ready_for_review" ? "A task waiting for review cannot be handed over." : "Stops the current run, keeps pending approvals and lets the chosen agent continue from the last checkpoint."}
            onClick={() => { setHandingOver((v) => !v); setHandoverError(null); }}
          >
            Hand over…
          </button>
        )}
        {!terminal && (
          <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" title={nextText} disabled={busy !== null} onClick={() => act("continue", () => onMessage("", "continue"))}>
            Continue
          </button>
        )}
        {!terminal && (
          <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" title={whatWillHappen(task, agentLike, "stop")} disabled={busy !== null || !!run?.stop_requested_at} onClick={() => act("stop", () => onMessage("", "stop"))}>
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
          <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" title={whatWillHappen(task, agentLike, "continue")} disabled={busy !== null} onClick={() => act("reopen", () => onMessage("", "continue"))}>
            Reopen
          </button>
        )}
        <button type="button" className="ml-auto rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-secondary" aria-expanded={showTimeline} onClick={() => setShowTimeline((v) => !v)}>
          {showTimeline ? "Hide timeline" : "Show timeline"}
        </button>
      </div>

      {handingOver && !terminal && task.state !== "ready_for_review" && onHandOver && (
        <div id={`${id}-handover`} className="space-y-2 rounded-md border border-border p-2">
          <label className="block text-xs" htmlFor={`${id}-handover-agent`}>Hand over to</label>
          <select id={`${id}-handover-agent`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" value={handoverTarget} onChange={(e) => setHandoverAgent(e.target.value)}>
            {agent && <option value="">Same agent, new session</option>}
            {handOverOthers.map((a) => <option key={a.id} value={a.id}>{a.name}{a.capabilities.resume ? " (resumes)" : ""}</option>)}
          </select>
          {!agent && handOverOthers.length === 0 && <p className="text-xs text-text-tertiary">No other agent is enabled in this workspace.</p>}
          <label className="block text-xs" htmlFor={`${id}-handover-note`}>Note for the next agent</label>
          <textarea id={`${id}-handover-note`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" maxLength={4000} value={handoverNote} onChange={(e) => setHandoverNote(e.target.value)} />
          {handoverError && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{handoverError}</p>}
          <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy !== null || (!agent && !handoverTarget)} onClick={() => void handOver()}>Hand over</button>
        </div>
      )}

      {closing && (
        <div className="space-y-1 rounded-md border border-border p-2">
          <p className="text-xs">{closing === "accepted" ? "Accept the deliverable and close the task." : "Close the task without accepting the deliverable."} Nothing is reverted.</p>
          <label htmlFor={`${id}-close-note`} className="sr-only">Closing note</label>
          <input id={`${id}-close-note`} className="w-full rounded border border-border bg-bg px-2 py-1 text-xs" placeholder="Note (optional)" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy !== null} onClick={() => act("close", () => onClose(closing, closeNote.trim() || null).then(() => setClosing(null)))}>
              Confirm
            </button>
            <button type="button" className="rounded px-3 py-1 text-xs text-text-secondary hover:bg-bg-secondary" onClick={() => setClosing(null)}>Keep open</button>
          </div>
        </div>
      )}

      {metrics && metrics.length > 0 && <MetricsList title="Results" metrics={metrics} />}

      {showTimeline && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Timeline</h4>
          <ActivityTimeline activities={activities} />
        </section>
      )}
    </div>
  );
}
