"use client";

import { Activity, useEffect, useId, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { useAgentsStore } from "@/lib/agentsStore";
import { taskForPage, useAgentTasks, type TaskRow } from "@/lib/agentTasks";
import { parseProgressReadMarkers, progressReadKey, progressRows, taskProgressState, updatedSinceRead, type ProgressReadMarkers, type ProgressTone } from "@/lib/agentProgress";
import { openTramaTaskDraft, useAgentProgressContext } from "@/lib/agentTramaContext";
import { buildProgressMilestones } from "@/lib/agentProgressActivity";
import { usePageBodies } from "@/lib/usePageBodies";
import { pageUrl, taskUrl, withQuery } from "@/lib/routes";
import { formatRelative } from "@/lib/utils";
import { isTrama } from "@/lib/tramaIdentity";
import type { DbRow } from "@/lib/types";
import { RowPanel } from "@/components/agents/RowPanel";
import { TramaAvatar } from "@/components/agents/TramaAvatar";
import "@/components/agents/taskProgress.css";

export interface TaskProgressProps {
  pageId: string;
  rows: DbRow[];
  allRows: DbRow[];
  onOpenRow?: (rowId: string) => void;
  active?: boolean;
}

const TONE: Record<ProgressTone, string> = {
  neutral: "bg-bg-secondary text-text-secondary", active: "bg-accent/10 text-accent",
  attention: "bg-yellow-500/10 text-yellow-800 dark:text-yellow-300",
  success: "bg-green-500/10 text-green-800 dark:text-green-300", error: "bg-red-500/10 text-red-700 dark:text-red-300",
};
const PROMPTS = [
  { label: "What changed?", prompt: "Summarize the meaningful progress on this task and its subtasks. Link to the delivery, review and evidence behind the summary." },
  { label: "What is still missing?", prompt: "Check this task against its current brief. Explain what is complete, what is missing, who is waiting, and what needs my decision. Cite the evidence." },
  { label: "Plan the next step", prompt: "Help me structure the next steps for this task. Propose a concrete plan with outcomes and responsibilities for my review before starting or assigning work." },
  { label: "Prepare team feedback", prompt: "Help me prepare actionable feedback on this task for the team and its agents. Show me a draft and ask for my approval before sending it." },
];

export function TaskProgress(props: TaskProgressProps) {
  const workspaceId = useStore((state) => state.syncWorkspaceId);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  if (!workspaceId || !userId) return <p className="p-4 text-sm text-text-secondary">Sign in to follow agent progress. Your table is still available.</p>;
  return <ProgressWorkspace key={`${workspaceId}:${userId}:${props.pageId}`} {...props} workspaceId={workspaceId} userId={userId} />;
}

function ProgressWorkspace({ pageId, rows, allRows, onOpenRow, active = true, workspaceId, userId }: TaskProgressProps & { workspaceId: string; userId: string }) {
  const contextOwner = useId();
  const pages = useStore((state) => state.pages);
  const storeWorkspace = useAgentTasks((state) => state.workspaceId);
  const tasks = useAgentTasks((state) => state.tasks);
  const runs = useAgentTasks((state) => state.runs);
  const approvals = useAgentTasks((state) => state.approvals);
  const activities = useAgentTasks((state) => state.activities);
  const reviews = useAgentTasks((state) => state.reviews);
  const taskStatus = useAgentTasks((state) => state.status);
  const taskError = useAgentTasks((state) => state.error);
  const subscribe = useAgentTasks((state) => state.subscribe);
  const load = useAgentTasks((state) => state.load);
  const loadTaskForPage = useAgentTasks((state) => state.loadTaskForPage);
  const agents = useAgentsStore((state) => state.agents);
  const loadAgents = useAgentsStore((state) => state.load);
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const requestedPage = new URLSearchParams(search).get("progressRow");
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const markerKey = progressReadKey(workspaceId, userId, pageId);
  const [readMarkers, setReadMarkers] = useState<ProgressReadMarkers>(() => {
    try { return parseProgressReadMarkers(localStorage.getItem(markerKey)); } catch { return {}; }
  });
  const [readError, setReadError] = useState(false);
  const [lookedUp, setLookedUp] = useState<Record<string, "ready" | "error">>({});
  const [lookupRetry, setLookupRetry] = useState(0);
  const activeTasks = useMemo(() => Object.fromEntries(Object.entries(tasks).filter(([, task]) => storeWorkspace === workspaceId && task.workspace_id === workspaceId)), [tasks, storeWorkspace, workspaceId]);
  const byPage = useMemo(() => new Map(allRows.map((row) => [row.pageId, taskForPage({ tasks: activeTasks }, row.pageId)])), [allRows, activeTasks]);
  const pending = useMemo(() => Object.values(approvals), [approvals]);
  const entries = useMemo(() => progressRows(rows, allRows), [rows, allRows]);
  const latestMilestones = useMemo(() => {
    const agentNames = Object.fromEntries(agents.map((agent) => [agent.id, agent.name]));
    const records = Object.values(activeTasks);
    const reviewRows = Object.values(reviews);
    return new Map(entries.flatMap(({ row }) => {
      const task = byPage.get(row.pageId);
      if (!task) return [];
      const subtasks = records.filter((child) => child.parent_task_id === task.id && child.request_kind == null);
      const family = [task, ...subtasks];
      const milestones = buildProgressMilestones({ task, subtasks, activities: family.flatMap((item) => activities[item.id] ?? []), reviews: reviewRows, agentNames, userId });
      return [[task.id, milestones.at(-1)] as const];
    }));
  }, [entries, byPage, activeTasks, activities, reviews, agents, userId]);
  const stateOf = (task: TaskRow) => taskProgressState(task, task.active_run_id ? runs[task.active_run_id] ?? null : null, pending, userId);
  const needsYou = new Set(entries.filter(({ row }) => {
    const task = byPage.get(row.pageId);
    if (!task || !stateOf(task).needsYou) return false;
    const parent = activeTasks[task.parent_task_id ?? ""];
    // Accepting the parent settles its delivered children. Independent pending
    // questions/actions still count and remain reachable on their own task.
    const ownDecision = pending.some((approval) => approval.task_id === task.id && approval.status === "pending" && Date.parse(approval.expires_at) > Date.now());
    return !(parent?.state === "ready_for_review" && task.state === "ready_for_review" && !ownDecision);
  }).map(({ row }) => row.id));
  const shownEntries = onlyNeedsYou ? entries.filter((entry) => needsYou.has(entry.row.id) || entries.some((child) => needsYou.has(child.row.id) && child.ancestors.includes(entry.row.id))) : entries;
  const selectedRow = requestedPage ? allRows.find((row) => row.pageId === requestedPage) ?? null : shownEntries[0]?.row ?? null;
  const selectedTask = selectedRow ? byPage.get(selectedRow.pageId) ?? null : null;
  const selectedEntry = selectedRow ? entries.find(({ row }) => row.id === selectedRow.id) : undefined;
  const bodyStatus = usePageBodies(selectedRow && pages[selectedRow.pageId] ? [selectedRow.pageId] : []);
  const pageReady = !!selectedRow && !!pages[selectedRow.pageId] && !pages[selectedRow.pageId].isDeleted && bodyStatus === "ready";
  const selectedOutsideView = !!selectedRow && !shownEntries.some(({ row, contextOnly }) => row.id === selectedRow.id && !contextOnly);
  const titleOf = (row: DbRow) => pages[row.pageId]?.title?.trim() || String(row.cells.title || "Untitled task");
  const title = selectedRow ? titleOf(selectedRow) : "Choose a task";
  const selectPage = (rowPageId: string) => { void navigate(withQuery(pathname + search + hash, { progressRow: rowPageId, taskLayout: "progress" })); };
  const openTask = (rowPageId: string, taskId: string) => {
    if (allRows.some((row) => row.pageId === rowPageId)) selectPage(rowPageId);
    else void navigate(taskUrl(rowPageId, taskId));
  };

  useEffect(() => {
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [workspaceId, loadAgents, subscribe]);

  const contextPageId = selectedTask?.row_page_id;
  useEffect(() => {
    if (active && contextPageId) useAgentProgressContext.setState({ context: { owner: contextOwner, workspaceId, userId, databaseId: pageId, pageId: contextPageId } });
    else if (useAgentProgressContext.getState().context?.owner === contextOwner) useAgentProgressContext.setState({ context: null });
    return () => {
      if (useAgentProgressContext.getState().context?.owner === contextOwner) useAgentProgressContext.setState({ context: null });
    };
  }, [active, contextPageId, contextOwner, workspaceId, userId, pageId]);

  // A default selection becomes a URL without adding a browser-history entry.
  useEffect(() => {
    if (active && !requestedPage && selectedRow) void navigate(withQuery(pathname + search + hash, { progressRow: selectedRow.pageId }), { replace: true });
  }, [active, requestedPage, selectedRow, pathname, search, hash, navigate]);

  const lookupPage = selectedRow?.pageId;
  useEffect(() => {
    if (!lookupPage || selectedTask || storeWorkspace !== workspaceId || taskStatus !== "ready") return;
    let current = true;
    void loadTaskForPage(lookupPage).then(() => {
      if (current) setLookedUp((previous) => ({ ...previous, [lookupPage]: "ready" }));
    }, () => {
      if (current) setLookedUp((previous) => ({ ...previous, [lookupPage]: "error" }));
    });
    return () => { current = false; };
  }, [lookupPage, selectedTask, taskStatus, storeWorkspace, workspaceId, loadTaskForPage, lookupRetry]);

  const selectedFamily = selectedTask ? Object.values(activeTasks).filter((task) => task.id === selectedTask.id || task.parent_task_id === selectedTask.id) : [];
  const updatedTasks = selectedFamily.filter((task) => updatedSinceRead(task, readMarkers));
  const markRead = () => {
    const next = { ...readMarkers };
    for (const task of selectedFamily) next[task.id] = task.last_activity_at ?? task.updated_at;
    const bounded = Object.fromEntries(Object.entries(next).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, 500));
    setReadMarkers(bounded);
    try { localStorage.setItem(markerKey, JSON.stringify(bounded)); setReadError(false); } catch { setReadError(true); }
  };
  const selectedState = selectedTask ? stateOf(selectedTask) : null;
  const taskLookupError = lookupPage && lookedUp[lookupPage] === "error";
  const loading = storeWorkspace !== workspaceId || (!!selectedRow && !selectedTask && (taskStatus === "loading" || lookedUp[selectedRow.pageId] === undefined));
  const tramaReady = agents.some((agent) => agent.workspace_id === workspaceId && isTrama(agent) && !agent.revoked_at);

  return <section className="task-progress" aria-label="Agent task progress">
    <div className="task-progress-heading">
      <p className="text-sm text-text-secondary">Results, reviews, and what happens next.</p>
      <div className="flex flex-wrap gap-1 rounded-lg border border-border p-1" aria-label="Progress filter">
        <button type="button" className="task-progress-filter" aria-pressed={!onlyNeedsYou} onClick={() => setOnlyNeedsYou(false)}>All work</button>
        <button type="button" className="task-progress-filter" aria-pressed={onlyNeedsYou} onClick={() => setOnlyNeedsYou(true)}>Needs you <span className="ml-1 tabular-nums">{needsYou.size}</span></button>
      </div>
    </div>
    {taskStatus === "error" && <p role="alert" className="mb-3 rounded-lg border border-border p-3 text-sm">{taskError || "Could not refresh tasks."} Your pages are kept. <button type="button" className="text-accent underline" onClick={() => void load(workspaceId)}>Try again</button></p>}
    {taskStatus === "loading" && selectedTask && <p role="status" className="mb-3 text-xs text-text-secondary">Refreshing progress. You can keep reviewing the saved work.</p>}
    <div className="task-progress-mobile-select">
      <label htmlFor={`progress-select-${pageId}`} className="mb-1 block text-xs text-text-secondary">Task</label>
      <select id={`progress-select-${pageId}`} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" value={selectedRow?.pageId ?? ""} onChange={(event) => selectPage(event.target.value)}>
        <option value="" disabled>Choose a task</option>
        {selectedOutsideView && selectedRow && <option value={selectedRow.pageId}>{title} (outside this view)</option>}
        {shownEntries.map(({ row, depth }) => <option key={row.id} value={row.pageId}>{depth ? "Subtask: " : ""}{titleOf(row)}</option>)}
      </select>
    </div>
    <div className="task-progress-layout">
      <nav className="task-progress-list" aria-label="Tasks and subtasks">
        <p className="mb-3 flex items-center justify-between px-2 text-xs text-text-tertiary"><span>WORK</span><span>{rows.length} {rows.length === 1 ? "item" : "items"}</span></p>
        {!shownEntries.length && <p className="px-2 py-5 text-sm text-text-secondary">{onlyNeedsYou ? "No loaded task is waiting on you in this view." : "No tasks match this view."}</p>}
        {shownEntries.filter(({ ancestors, row }) => row.id === selectedRow?.id || onlyNeedsYou || ancestors.every((parent) => expanded.has(parent) || selectedEntry?.ancestors.includes(parent))).map(({ row, depth, contextOnly }) => {
          const task = byPage.get(row.pageId), state = task ? stateOf(task) : null;
          const children = entries.some((entry) => entry.row.parentRowId === row.id);
          const isOpen = expanded.has(row.id) || !!selectedEntry?.ancestors.includes(row.id);
          const agent = task?.delegate_agent_id ? agents.find((entry) => entry.id === task.delegate_agent_id) : null;
          const family = task ? Object.values(activeTasks).filter((child) => child.id === task.id || child.parent_task_id === task.id) : [];
          const updated = family.some((child) => updatedSinceRead(child, readMarkers));
          const milestone = task ? latestMilestones.get(task.id) : undefined;
          return <div key={row.id} className={`task-progress-list-item ${selectedRow?.id === row.id ? "is-selected" : ""}`} style={{ marginLeft: Math.min(depth, 3) * 12 }}>
            <button type="button" className="task-progress-task" aria-current={selectedRow?.id === row.id ? "true" : undefined} onClick={() => selectPage(row.pageId)}>
              <span className="mb-2 block break-words text-sm font-medium">{titleOf(row)}</span>
              <span className="flex flex-wrap items-center gap-1.5"><span className={`task-progress-badge ${TONE[state?.tone ?? "neutral"]}`}>{state?.label ?? "Open details"}</span>{updated && <span className="text-xs font-medium text-accent">Updated</span>}</span>
              <span className="mt-2 block truncate text-xs text-text-secondary">{agent ? `${task?.parent_task_id ? "Worker" : "Lead"}: ${agent.name}` : task ? "No agent assigned" : "Task details load when opened"}</span>
              {milestone && <span className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-text-secondary" title={`${milestone.author}: ${milestone.label}\n${milestone.detail}`}>{milestone.author}: {milestone.label}</span>}
              {task?.last_activity_at && <time className="mt-1 block text-[11px] text-text-tertiary" dateTime={task.last_activity_at} title={new Date(task.last_activity_at).toLocaleString()}>Last activity {formatRelative(Date.parse(task.last_activity_at))}</time>}
              {contextOnly && <span className="mt-1 block text-[11px] text-text-tertiary">Parent of a matching subtask</span>}
            </button>
            {children && <button type="button" className="task-progress-expand" aria-label={`${isOpen ? "Collapse" : "Expand"} subtasks of ${titleOf(row)}`} aria-expanded={isOpen} onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>}
          </div>;
        })}
      </nav>
      <section className="task-progress-detail" aria-label="Selected task">
        {selectedRow ? <>
          <header className="task-progress-detail-heading">
            <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{selectedTask?.parent_task_id || selectedRow.parentRowId ? "Subtask" : "Shared task"}</p><h3 className="mt-2 break-words text-xl font-semibold leading-tight">{title}</h3></div>
            <div className="flex flex-wrap items-center gap-3">{onOpenRow && <button type="button" className="text-xs text-text-secondary underline underline-offset-2" onClick={() => onOpenRow(selectedRow.id)}>Row properties</button>}<a className="task-progress-open" href={selectedTask ? taskUrl(selectedRow.pageId, selectedTask.id) : pageUrl(selectedRow.pageId)} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void navigate(selectedTask ? taskUrl(selectedRow.pageId, selectedTask.id) : pageUrl(selectedRow.pageId)); }}>Open full page <ArrowUpRight size={14} aria-hidden="true" /></a></div>
          </header>
          {selectedOutsideView && <p className="mb-4 rounded-lg bg-bg-secondary p-3 text-xs text-text-secondary">This task is outside the current filter. It stays open so you can finish reviewing it.</p>}
          {selectedTask && <div className="task-progress-current">
            {updatedTasks.length > 0 && <p role="status" className="text-xs font-medium text-accent">New activity since you last checked this task.</p>}
            <button type="button" className="text-xs text-accent underline underline-offset-2" onClick={markRead}>{selectedFamily.some((task) => readMarkers[task.id]) ? "Mark as read" : "Mark this point as read"}</button>
            <span className="text-[11px] text-text-tertiary">For you on this device.</span>
            {readError && <p role="status" className="mt-1 text-xs text-text-secondary">The read marker lasts for this visit. Your browser could not save it.</p>}
          </div>}
          {taskLookupError ? <p role="alert" className="py-5 text-sm">Could not load this task. <button type="button" className="text-accent underline" onClick={() => { setLookedUp((previous) => { const next = { ...previous }; delete next[selectedRow.pageId]; return next; }); setLookupRetry((value) => value + 1); }}>Try again</button></p>
            : loading || bodyStatus === "loading" ? <p role="status" className="py-8 text-sm text-text-secondary">Loading saved work…</p>
              : !pageReady ? <p className="py-5 text-sm text-text-secondary">This page is not available on this device yet. Open the full page to load it.</p>
                : null}
        </> : <div className="py-16 text-center"><h3 className="font-medium">{requestedPage ? "This task is no longer in this database." : "Choose a task to follow its progress."}</h3><p className="mt-2 text-sm text-text-secondary">Your saved views, pages and history remain available in the table.</p></div>}
        <ProgressTaskPanels selectedPageId={pageReady && !loading && !taskLookupError ? selectedRow?.pageId ?? null : null} availablePageIds={allRows.map((row) => row.pageId)} active={active} onOpenTask={openTask} />
      </section>
      <aside className="task-progress-trama" aria-label="Trama task context">
        <div className="flex items-center gap-2.5"><TramaAvatar size={40} decorative /><div><h3 className="font-semibold">Trama</h3><span className="mt-1 inline-flex items-center gap-1 rounded-full border border-accent/15 bg-accent/5 px-2 py-0.5 text-[10px] text-accent"><Sparkles size={10} aria-hidden="true" />Powered by Muse</span></div></div>
        <p className="mt-4 text-sm leading-relaxed text-text-secondary">Your workspace AI agent. Make sense of progress, shape the project, and coordinate the next step.</p>
        <div className="my-4 border-t border-border pt-4"><p className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Current context</p><p className="mt-1 break-words text-sm font-medium">{title}</p>{selectedState && <p className="mt-2 text-xs leading-relaxed text-text-secondary">{selectedState.detail}</p>}</div>
        <div className="space-y-2">{PROMPTS.map(({ label, prompt }) => <button key={label} type="button" className="task-progress-trama-action" disabled={!selectedTask || !tramaReady} onClick={() => { if (selectedTask) openTramaTaskDraft({ workspaceId, taskId: selectedTask.id, pageId: selectedTask.row_page_id, prompt }); }}>{label}<ChevronRight size={13} aria-hidden="true" /></button>)}</div>
        <p className="mt-3 text-[11px] leading-relaxed text-text-tertiary">{!tramaReady ? "Trama is not connected in this workspace yet." : "Opens a draft with this task as context. You choose when to send it."}</p>
      </aside>
    </div>
  </section>;
}

function ProgressTaskPanels({ selectedPageId, availablePageIds, active, onOpenTask }: {
  selectedPageId: string | null; availablePageIds: string[]; active: boolean; onOpenTask: (pageId: string, taskId: string) => void;
}) {
  const [visited, setVisited] = useState<string[]>([]);
  if (selectedPageId && !visited.includes(selectedPageId)) setVisited([...visited, selectedPageId]);
  // Each visited task keeps its own forms during this visit. Hidden activities
  // stop subscriptions/effects; returning restores drafts without sending them.
  return <>{visited.filter((pageId) => availablePageIds.includes(pageId)).map((pageId) => {
    const visible = active && selectedPageId === pageId;
    return <div key={pageId} data-progress-panel={pageId} hidden={!visible} inert={!visible}>
      <Activity mode={visible ? "visible" : "hidden"}><RowPanel pageId={pageId} embedded onOpenTask={onOpenTask} /></Activity>
    </div>;
  })}</>;
}
