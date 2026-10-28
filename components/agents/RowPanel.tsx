"use client";

import { useEffect, useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { pageUrl, taskUrl } from "@/lib/routes";
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
import { briefFromRow, closeTask, createTask, decideApproval, reviewTask, sendMessage } from "@/lib/agentActions";
import { AssignView, TaskView, type SubtaskItem } from "@/components/agents/panel";

// Agent layer plug. Mounted by the page view of a database row, under the row
// properties (also reached through the `?task=` deep link). Workspace
// connector: loads and subscribes, selects the data, navigates and calls the
// actions; the views in components/agents/panel render it.
export interface RowPanelProps {
  pageId: string;
}

export function RowPanel({ pageId }: RowPanelProps) {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  const subscribe = useAgentTasks((s) => s.subscribe);
  const loadAgents = useAgentsStore((s) => s.load);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestedId = params.get("task");
  const status = useAgentTasks((s) => s.status);
  const requested = useAgentTasks((s) => (requestedId ? (s.tasks[requestedId] ?? null) : null));
  const pageTask = useAgentTasks((s) => taskForPage(s, pageId));
  // `?task=<id>` selects that task when it belongs to this row; otherwise the
  // person is told explicitly instead of being shown another task as if it were it.
  const task = requested && requested.row_page_id === pageId ? requested : pageTask;
  const mismatch = requestedId && status === "ready" && (!requested || requested.row_page_id !== pageId) ? (requested ? "elsewhere" : "missing") : null;
  const onOpenTask = (rowPageId: string, taskId: string) => { void navigate(taskUrl(rowPageId, taskId)); };
  const onOpenPage = (id: string) => { void navigate(pageUrl(id)); };

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
      {mismatch === "missing" && (
        <p className="rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-xs" role="status">
          The task in this link no longer exists, or you cannot see it. Below is this row&apos;s own task.
        </p>
      )}
      {mismatch === "elsewhere" && requested && (
        <p className="rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-xs" role="status">
          The task in this link belongs to another row.{" "}
          <a className="text-accent underline" href={taskUrl(requested.row_page_id, requested.id)} onClick={(e) => { e.preventDefault(); onOpenTask(requested.row_page_id, requested.id); }}>
            Open {requested.title || "it"} there
          </a>
          . Below is this row&apos;s own task.
        </p>
      )}
      {task ? <TaskConnector task={task} onOpenTask={onOpenTask} onOpenPage={onOpenPage} /> : <AssignConnector pageId={pageId} />}
    </section>
  );
}

function AssignConnector({ pageId }: { pageId: string }) {
  const agents = useAgentsStore((s) => s.agents);
  const enabled = useMemo(() => agents.filter((a) => a.status === "enabled"), [agents]);
  const onAssign = async (agentId: string | null, note: string) => {
    const brief = briefFromRow(pageId);
    if (note.trim()) brief.next_step = note.trim();
    await createTask(pageId, brief, agentId);
  };
  return <AssignView agents={enabled} onAssign={onAssign} />;
}

function TaskConnector({ task, onOpenTask, onOpenPage }: { task: TaskRow; onOpenTask: (pageId: string, taskId: string) => void; onOpenPage: (pageId: string) => void }) {
  const { hash } = useLocation();
  // `#approval-<id>` (a deep link from a chat or a notification) lands on that approval.
  const focusApprovalId = useMemo(() => {
    const m = /^#approval-(.+)$/.exec(hash);
    return m ? decodeURIComponent(m[1]) : null;
  }, [hash]);
  const agents = useAgentsStore((s) => s.agents);
  const run = useAgentTasks((s) => activeRunFor(s, task));
  const approval = useAgentTasks((s) => pendingApprovalFor(s, task.id));
  const artifact = useAgentTasks((s) => currentArtifactFor(s, task.id));
  const review = useAgentTasks((s) => latestReviewFor(s, task.id));
  const brief = useAgentTasks((s) => currentBriefFor(s, task));
  const activities = useAgentTasks((s) => s.activities[task.id]);
  const tasks = useAgentTasks((s) => s.tasks);
  const runs = useAgentTasks((s) => s.runs);
  const loadBriefs = useAgentTasks((s) => s.loadBriefs);
  const loadActivities = useAgentTasks((s) => s.loadActivities);

  useEffect(() => {
    void loadBriefs(task.id);
  }, [task.id, task.brief_version, loadBriefs]);
  useEffect(() => {
    void loadActivities(task.id);
  }, [task.id, task.last_activity_at, loadActivities]);

  const agent = agents.find((a) => a.id === task.delegate_agent_id) ?? null;
  const subtasks = useMemo<SubtaskItem[]>(
    () =>
      Object.values(tasks)
        .filter((t) => t.parent_task_id === task.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((t) => ({ task: t, run: t.active_run_id ? (runs[t.active_run_id] ?? null) : null, agentName: agents.find((a) => a.id === t.delegate_agent_id)?.name ?? null })),
    [tasks, runs, agents, task.id],
  );

  return (
    <TaskView
      task={task}
      agent={agent}
      run={run}
      approval={approval}
      artifact={artifact}
      review={review}
      brief={brief}
      activities={activities ?? []}
      subtasks={subtasks}
      reviewerName={review ? (agents.find((a) => a.id === review.reviewer_id)?.name ?? null) : null}
      focusApprovalId={focusApprovalId}
      onMessage={(body, signal) => sendMessage(task.id, body, signal).then(() => undefined)}
      onClose={(acceptance, note) => closeTask(task.id, acceptance, note)}
      onDecide={(decision, response) => (approval ? decideApproval(approval.id, decision, response).then(() => undefined) : Promise.resolve())}
      onReview={(verdict, findings, artifactId) => reviewTask(task.id, verdict, findings, [], artifactId).then(() => undefined)}
      onOpenTask={onOpenTask}
      onOpenPage={onOpenPage}
    />
  );
}
