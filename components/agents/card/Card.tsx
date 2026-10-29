import { useState } from "react";
import type { MessageSignal } from "@/lib/agentActions";
import { approvalLink, cardDataFrom, openQuestionsFor, pageLink, taskLink, toolFailure, type CardData, type TaskCardData, type WaitingItem, type WaitingListData } from "@/lib/agentCard";
import type { ToolResult } from "@/lib/agentCardHost";
import { TaskView, type SubtaskItem } from "@/components/agents/panel";
import { WaitingList } from "@/components/agents/card/WaitingList";

// The task card: the pure panel views driven by the data the host passed in,
// with every action mapped to a tools/call through the host. Mount it with a
// fresh `key` for each tool result; it keeps its own state afterwards.

export interface CardActions {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  openLink(url: string): void;
}

interface Notice {
  text: string;
  url: string | null;
}

interface TaskLink {
  pageId: string;
  taskId: string;
}

// Continue and Stop send no text from the panel; the tool wants a body.
const DEFAULT_BODY: Record<MessageSignal, string> = { continue: "Continue.", feedback: "", stop: "Stop." };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function Card({ initial, actions }: { initial: CardData; actions: CardActions }) {
  const [data, setData] = useState<CardData>(initial);
  const [list] = useState<WaitingListData | null>(initial.kind === "waiting" ? initial : null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const appUrl = data.app_url;
  const canOpen = /^https?:\/\//.test(appUrl);
  const openLink = canOpen ? (url: string) => actions.openLink(url) : null;

  // One tool call: a failed result becomes an Error for the view that asked,
  // and a decision the server wants taken in the app also becomes a notice.
  const call = async (name: string, args: Record<string, unknown>, link: TaskLink | null) => {
    const result = await actions.callTool(name, args);
    const failure = toolFailure(result);
    if (failure) {
      const detailUrl = isObject(failure.detail) && typeof failure.detail.url === "string" ? failure.detail.url : null;
      const approvalId = name === "decide_approval" && typeof args.approval_id === "string" ? args.approval_id : null;
      const fallback = !link || !canOpen ? null
        : approvalId ? approvalLink(appUrl, link.pageId, link.taskId, approvalId) : taskLink(appUrl, link.pageId, link.taskId);
      const url = detailUrl ?? fallback;
      if (failure.code === "direct_session_required") setNotice({ text: failure.message, url });
      throw new Error(failure.message);
    }
    return result;
  };

  const showTask = async (taskId: string): Promise<TaskCardData> => {
    const result = await call("get_task", { task_id: taskId, activities_limit: 20 }, null);
    const next = cardDataFrom(result.structuredContent);
    if (next?.kind !== "task") throw new Error("The task could not be loaded.");
    setNotice(null);
    setData(next);
    return next;
  };

  // Write tools return the refreshed card; anything else is followed by get_task.
  const applyResult = async (result: ToolResult, taskId: string) => {
    const next = cardDataFrom(result.structuredContent);
    if (next?.kind === "task") {
      setNotice(null);
      setData(next);
    } else {
      await showTask(taskId);
    }
  };

  const onShow = async (item: WaitingItem) => {
    setBusy(item.task_id);
    try {
      await showTask(item.task_id);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), url: canOpen ? item.url : null });
    } finally {
      setBusy(null);
    }
  };

  const openUrl = data.kind === "task" ? taskLink(appUrl, data.task.row_page_id, data.task.id) : `${appUrl}/`;
  const title = data.kind === "task" ? data.task.title || "Untitled task" : "Waiting on you";

  return (
    <div className="space-y-3 text-sm" style={{ padding: "var(--safe-top, 12px) var(--safe-right, 12px) var(--safe-bottom, 12px) var(--safe-left, 12px)" }}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-tertiary">
        <span className="min-w-0 truncate">
          <span className="font-medium text-text-secondary">colabora.si</span> · {title}
        </span>
        <span className="flex gap-3">
          {list && data.kind === "task" && (
            <button type="button" className="rounded px-1 hover:bg-bg-secondary" onClick={() => { setNotice(null); setData(list); }}>
              Back to the list
            </button>
          )}
          {openLink && (
            <a className="text-accent underline" href={openUrl} onClick={(e) => { e.preventDefault(); openLink(openUrl); }}>
              Open in app
            </a>
          )}
        </span>
      </header>

      {notice && (
        <p role="status" className="rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-xs">
          {notice.text}
          {notice.url && openLink && (
            <>
              {" "}
              <a className="text-accent underline" href={notice.url} onClick={(e) => { e.preventDefault(); openLink(notice.url!); }}>
                Open it in colabora
              </a>
            </>
          )}
        </p>
      )}

      {data.kind === "waiting" ? (
        <WaitingList data={data} busy={busy} onShow={(item) => void onShow(item)} onOpen={openLink ? (item) => openLink(item.url) : null} />
      ) : (
        <TaskCard data={data} call={call} applyResult={applyResult} refresh={() => showTask(data.task.id).then(() => undefined)} openLink={openLink} />
      )}
    </div>
  );
}

function TaskCard({
  data,
  call,
  applyResult,
  refresh,
  openLink,
}: {
  data: TaskCardData;
  call: (name: string, args: Record<string, unknown>, link: TaskLink | null) => Promise<ToolResult>;
  applyResult: (result: ToolResult, taskId: string) => Promise<void>;
  refresh: () => Promise<void>;
  openLink: ((url: string) => void) | null;
}) {
  const { task, approval, review } = data;
  const link: TaskLink = { pageId: task.row_page_id, taskId: task.id };
  const agent = data.agents.find((a) => a.id === task.delegate_agent_id) ?? null;
  const subtasks: SubtaskItem[] = data.subtasks.map((s) => ({ task: s.task, run: s.run, agentName: s.agent_name }));
  const reviewerName = review ? (data.agents.find((a) => a.id === review.reviewer_id)?.name ?? null) : null;

  return (
    <TaskView
      continuity={data.continuity ?? null}
      diff={data.diff ?? null}
      task={task}
      agent={agent}
      run={data.run}
      approval={approval}
      openQuestions={data.approvals_pending ? openQuestionsFor(data.approvals_pending, task.id, approval?.id ?? null) : (data.questions ?? [])}
      autonomy={data.autonomy ?? null}
      onDecideQuestion={async (id, decision, response) => {
        const result = await call("decide_approval", { approval_id: id, decision, ...(response ? { response } : {}) }, link);
        await applyResult(result, task.id);
      }}
      artifact={data.artifact}
      review={review}
      brief={data.brief}
      activities={data.activities}
      subtasks={subtasks}
      reviewerName={reviewerName}
      onMessage={async (body, signal) => {
        await call("send_message", { task_id: task.id, body: body || DEFAULT_BODY[signal], signal }, link);
        await refresh();
      }}
      onClose={async (acceptance, note) => {
        const result = await call("close_task", { task_id: task.id, acceptance, ...(note ? { note } : {}) }, link);
        await applyResult(result, task.id);
      }}
      onDecide={async (decision, response) => {
        if (!approval) return;
        const result = await call("decide_approval", { approval_id: approval.id, decision, ...(response ? { response } : {}) }, link);
        await applyResult(result, task.id);
      }}
      onReview={async (verdict, findings, artifactId) => {
        await call("review_task", { task_id: task.id, verdict, findings, ...(artifactId ? { artifact_id: artifactId } : {}) }, link);
        await refresh();
      }}
      onOpenTask={(pageId, taskId) => openLink?.(taskLink(data.app_url, pageId, taskId))}
      onOpenPage={(pageId) => openLink?.(pageLink(data.app_url, pageId))}
    />
  );
}
