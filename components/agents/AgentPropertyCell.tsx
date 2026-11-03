"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { activeRunFor, subtaskWorkers, taskForPage, useAgentTasks } from "@/lib/agentTasks";
import { taskSubtitle } from "@/lib/agentTaskText";
import { StatusBadge } from "@/components/agents/panel/StatusBadge";
import { JobAgentPicker } from "@/components/agents/panel/JobAgentPicker";
import { eligibleJobAgents, jobAgentNames, jobState, jobWait, jobWorkerIds, subtaskState, subWait, JOB_STATE_LABEL, SUBTASK_STATE_LABEL, type JobAgent } from "@/lib/agentJobs";
import { connectedRows, loadConnections } from "@/lib/agentConnect";
import { connectWorkspaces } from "@/lib/agentConsent";
import { getAgentClient } from "@/lib/agentClient";
import { assignJob, setSubtaskWorker } from "@/lib/agentActions";
import { AGENTS_URL, CONNECT_URL } from "@/lib/routes";
import type { GrantRow } from "@/lib/agentsStore";
import type { Page } from "@/lib/types";

export { StatusBadge };

// Agent layer plug. Mounted by the database views as the cell of the
// `agentStatus` and `agentDelegate` property types. Read-only: the row panel
// is where the person acts.
export interface AgentPropertyCellProps {
  pageId: string;
  propertyId: string;
  kind: "agentStatus" | "agentDelegate" | "jobLead" | "agentWaiting" | "agentDoneWhen";
  dbPageId?: string;
  isJob?: boolean;
  isSubtask?: boolean;
  readOnly?: boolean;
  fallbackName?: string;
}

export function AgentPropertyCell(props: AgentPropertyCellProps) {
  if (props.kind === "jobLead" || (props.kind === "agentDelegate" && (props.isJob || props.isSubtask))) return <JobAssignmentCell {...props} />;
  return <TaskPropertyCell {...props} />;
}

function TaskPropertyCell({ pageId, dbPageId, kind, isJob, isSubtask }: AgentPropertyCellProps) {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const loadAgents = useAgentsStore((s) => s.load);
  useEffect(() => {
    if (!workspaceId) return;
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [workspaceId, subscribe, loadAgents]);
  const task = useAgentTasks((s) => taskForPage(s, pageId));
  const run = useAgentTasks((s) => (task ? activeRunFor(s, task) : null));
  const agents = useAgentsStore((s) => s.agents);
  const tasks = useAgentTasks((state) => state.tasks), briefs = useAgentTasks((state) => state.briefs), loadBriefs = useAgentTasks((state) => state.loadBriefs);
  const pages = useStore((state) => state.pages);
  const taskId = task?.id, briefVersion = task?.brief_version;
  useEffect(() => { if (taskId && kind === "agentDoneWhen") void loadBriefs(taskId); }, [taskId, briefVersion, kind, loadBriefs]);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent";
  const agentName = task?.delegate_agent_id ? nameOf(task.delegate_agent_id) : null;
  // A task with subtasks shows who does them; the agent it is assigned to already appears as its Lead.
  const workers = useAgentTasks((s) => (task && kind === "agentDelegate" ? subtaskWorkers(s.tasks, task.id).join(",") : ""));
  const workerIds = workers ? workers.split(",") : [];
  const workerName = workerIds.length > 1 ? `${workerIds.length} workers` : workerIds.length === 1 ? nameOf(workerIds[0]) : agentName;

  const children = task ? Object.values(tasks).filter((child) => child.parent_task_id === task.id && child.request_kind == null) : [];
  const database = pages?.[dbPageId ?? ""]?.database, row = database?.rows.find((item) => item.pageId === pageId);
  const pending = row ? database!.rows.filter((item) => item.parentRowId === row.id && !Object.values(tasks).some((child) => child.row_page_id === item.pageId && child.request_kind == null)) : [];
  const subtasks = [...children, ...pending.map(() => null)];
  if (kind === "agentDoneWhen") return <span className="cell-readonly">{task ? briefs[`${task.id}:${task.brief_version}`]?.done_when.map((criterion) => criterion.text).join("; ") ?? "" : ""}</span>;
  if (kind === "agentWaiting") {
    const wait = isJob ? jobWait(task, subtasks) : { label: subWait(task), count: 0 };
    return <span className={`cell-readonly ${wait.label === "You" ? "text-[var(--c-yellow)]" : "text-text-secondary"}`}>{wait.label}{wait.count ? ` ${wait.count}` : ""}</span>;
  }
  if (kind === "agentStatus" && (isJob || isSubtask)) {
    const label = isJob ? JOB_STATE_LABEL[jobState(task, subtasks)] : SUBTASK_STATE_LABEL[subtaskState(task)];
    const needsYou = task?.waiting_on === "human" || (isJob ? jobWait(task, subtasks).label : subWait(task)) === "You";
    return <span className="cell-readonly"><span className={`rounded px-1.5 py-0.5 text-xs ${task?.state === "done" ? "bg-[var(--bgc-green)] text-[var(--c-green)]" : needsYou ? "bg-[var(--bgc-yellow)] text-[var(--c-yellow)]" : "bg-bg-secondary text-text-secondary"}`}>{label}</span></span>;
  }

  if (kind === "agentDelegate") {
    return <span className={"cell-readonly " + (workerName ? "" : "text-text-tertiary")} title={workerName ? "Assigned agent" : "Open the row to assign an agent"}>{workerName ?? "Unassigned"}</span>;
  }
  if (!task) return <span className="cell-readonly text-text-tertiary" title="Open the row to hand it to an agent">No task</span>;
  return (
    <span className="cell-readonly" title={taskSubtitle(task, run, agentName)}>
      <StatusBadge task={task} run={run} agentName={agentName} />
    </span>
  );
}

function databaseGrant(grant: GrantRow, dbPageId: string, pages: Record<string, Page>, scopes: string[]) {
  if (grant.revoked_at || (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) || !scopes.every((scope) => grant.scopes.includes(scope))) return false;
  if (grant.page_id === dbPageId) return grant.inherit;
  const visited = new Set<string>();
  let parent = pages[dbPageId]?.parentId;
  while (parent && !visited.has(parent)) {
    if (grant.inherit && grant.page_id === parent) return true;
    visited.add(parent); parent = pages[parent]?.parentId;
  }
  return false;
}

export function JobAccessNote({ dbPageId }: { dbPageId: string }) {
  const agents = useAgentsStore((state) => state.agents), grants = useAgentsStore((state) => state.grants);
  const pages = useStore((state) => state.pages);
  const names = agents.filter((agent) => !agent.is_platform && !agent.revoked_at && grants.some((grant) => grant.agent_id === agent.id && databaseGrant(grant, dbPageId, pages, ["read"]))).map((agent) => agent.name);
  return <p className="mb-3 text-[13px] text-text-secondary">{names.length ? `${jobAgentNames(names)} can see every job here. ` : ""}To keep a project apart, use a separate database.</p>;
}

function JobAssignmentCell({ pageId, dbPageId, kind, readOnly, fallbackName, isSubtask }: AgentPropertyCellProps) {
  const workspaceId = useStore((state) => state.syncWorkspaceId), pages = useStore((state) => state.pages);
  const agents = useAgentsStore((state) => state.agents), grants = useAgentsStore((state) => state.grants), loadAgents = useAgentsStore((state) => state.load);
  const subscribe = useAgentTasks((state) => state.subscribe), task = useAgentTasks((state) => taskForPage(state, pageId));
  const plan = useAgentTasks((state) => state.rowPlans[pageId]);
  const tasks = useAgentTasks((state) => state.tasks), rowPlans = useAgentTasks((state) => state.rowPlans);
  const [anchor, setAnchor] = useState<DOMRect | null>(null), [choices, setChoices] = useState<JobAgent[]>([]);
  const [canGrant, setCanGrant] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setAnchor(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [anchor]);
  useEffect(() => {
    if (!workspaceId) return;
    void loadAgents(workspaceId);
    return subscribe(workspaceId);
  }, [workspaceId, subscribe, loadAgents]);
  const lead = kind === "jobLead", workerIds = task?.named_worker_ids ?? [];
  // A job's Worker cell shows everyone on the job, not only the Workers a person named: the Lead
  // gives subtasks to agents of its own, and a person can set one on a subtask before the Lead adopts it.
  const subtasks = !lead && !isSubtask && task ? Object.values(tasks).filter((child) => child.parent_task_id === task.id && child.request_kind == null) : [];
  const database = pages[dbPageId ?? ""]?.database, row = !lead && !isSubtask ? database?.rows.find((item) => item.pageId === pageId) : undefined;
  const planned = row ? database!.rows.filter((item) => item.parentRowId === row.id && !subtasks.some((child) => child.row_page_id === item.pageId)).map((item) => rowPlans[item.pageId]?.worker_agent_id) : [];
  const jobWorkers = lead || isSubtask ? [] : jobWorkerIds(task, subtasks, planned);
  const selectedIds = lead || isSubtask ? (task?.delegate_agent_id ?? (isSubtask ? plan?.worker_agent_id : null)) ? [task?.delegate_agent_id ?? plan!.worker_agent_id!] : [] : jobWorkers;
  const selected = connectedRows(agents, []).filter((agent) => selectedIds.includes(agent.agentId));
  const started = !!task && (task.state !== "queued" || !!task.active_run_id);
  const locked = readOnly || (isSubtask && !!task) || (lead && started) || task?.state === "done";
  // A Worker that came through a subtask is removed on that subtask, not here; a named one stays once the job started.
  const lockedIds = lead || isSubtask ? [] : started ? selectedIds : selectedIds.filter((id) => !workerIds.includes(id));
  const label = selected.length ? lead || selected.length === 1 ? selected[0].name : `${selected.length} workers` : lead ? fallbackName || "Choose a Lead" : isSubtask ? "Lead chooses" : "Optional";
  const names = selected.length > 1 ? jobAgentNames(selected.map((agent) => agent.name)) : undefined;
  const open = async (rect: DOMRect) => {
    setError(null); setBusy(true);
    try {
      const client = getAgentClient();
      if (!client || !workspaceId) throw new Error("No connection. Agents need you to sign in.");
      const [connections, spaces] = await Promise.all([loadConnections(client, workspaceId), connectWorkspaces(client), loadAgents(workspaceId)]);
      setChoices(eligibleJobAgents(useAgentsStore.getState().agents, connections));
      setCanGrant(spaces.some((space) => space.id === workspaceId)); setAnchor(rect);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const choose = async (id: string) => {
    const leadId = lead ? id : task?.delegate_agent_id;
    if (!isSubtask && !leadId) { setError("Choose a Lead first."); return; }
    setBusy(true); setError(null);
    try {
      const workers = lead ? workerIds.filter((worker) => worker !== id) : workerIds.includes(id) ? workerIds.filter((worker) => worker !== id) : [...workerIds, id];
      const result = isSubtask ? await setSubtaskWorker(pageId, id || null) : await assignJob(pageId, leadId!, workers);
      const database = pages[dbPageId ?? ""]?.title ?? "this database";
      setNotice(result.granted_agents.map((agent) => `${agent.name} now has access to ${database}, so it can see every job here.`).join(" ") || null);
      await loadAgents(workspaceId);
      if (lead || isSubtask) setAnchor(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const blocked = canGrant ? [] : choices.filter((agent) => !dbPageId || !grants.some((grant) => grant.agent_id === agent.id && databaseGrant(grant, dbPageId, pages, ["read", "write", "comment"]))).map((agent) => agent.id);
  return <div className="min-w-0">
    <button type="button" className="cell-button flex items-center gap-1.5" aria-label={lead ? `Lead: ${label}` : `Workers: ${names ?? label}`} title={names} aria-haspopup="dialog" aria-expanded={!!anchor} disabled={locked || busy} onClick={(event) => { void open(event.currentTarget.getBoundingClientRect()); }}>
      {selected.map((agent) => agent.logo && <img key={agent.agentId} src={agent.logo} alt="" className="h-5 w-5 shrink-0 object-contain" />)}<span className={`truncate ${!selected.length ? "text-text-secondary" : ""}`}>{label}</span>
    </button>
    {notice && <p role="status" className="px-2 text-xs text-[var(--c-green)]">{notice}</p>}
    {error && <p role="alert" className="px-2 text-xs text-[var(--c-red)]">{error}</p>}
    {anchor && createPortal(<><button type="button" className="cell-backdrop" aria-label="Close menu" onClick={() => setAnchor(null)} /><div className="cell-popover max-h-[70vh] overflow-auto" style={{ width: Math.min(340, innerWidth - 16), left: Math.max(8, Math.min(anchor.left, innerWidth - 348)), top: Math.max(8, Math.min(anchor.bottom + 4, innerHeight - 360)) }}>
      <JobAgentPicker kind={lead ? "lead" : isSubtask ? "subtask" : "workers"} agents={choices} selectedIds={selectedIds} leadId={task?.delegate_agent_id ?? undefined} busy={busy} blockedAgentIds={blocked} lockedIds={lockedIds} onChoose={(id) => { void choose(id); }} onClose={() => setAnchor(null)} connectHref={CONNECT_URL} agentsHref={AGENTS_URL} />
    </div></>, document.body)}
  </div>;
}
