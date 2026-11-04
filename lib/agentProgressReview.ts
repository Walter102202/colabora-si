import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getTaskAutonomy, subscribeWorkspaceAutonomy, workspaceAutonomyVersion } from "@/lib/agentActions";
import { getAgentClient } from "@/lib/agentClient";
import { useAgentTasks, type BriefRow, type TaskRow } from "@/lib/agentTasks";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import type { AgentRow } from "@/lib/agentsStore";
import type { JobCiStatus } from "@/lib/agentCi";
import type { ProgressReviewContext } from "@/lib/agentProgress";

interface ReviewRequest {
  taskId: string;
  policyTaskId: string;
  version: number;
  job: boolean;
  workspaceId: string;
  userId: string;
  revision: string;
}
interface ReviewResult { value: ProgressReviewContext; error: boolean; }
interface CachedReview extends ReviewResult { revision: string; }
const UNKNOWN: ProgressReviewContext = { autonomy: null, personCriteria: null, ciState: null };

function sameScope(request: ReviewRequest): boolean {
  return useStore.getState().syncWorkspaceId === request.workspaceId
    && useAgentTasks.getState().workspaceId === request.workspaceId
    && useAuthStore.getState().user?.id === request.userId;
}

function personCriteria(brief: Pick<BriefRow, "done_when">): boolean | null {
  if (brief.done_when.some((criterion) => criterion.check === "human" && criterion.by === "person")) return true;
  // Missing historical authorship is unknown. The UI must not invent an agent author.
  return brief.done_when.some((criterion) => criterion.check === "human" && !criterion.by) ? null : false;
}

async function readReview(request: ReviewRequest, signal: AbortSignal): Promise<ReviewResult> {
  const client = getAgentClient();
  if (!client || signal.aborted || !sameScope(request)) return { value: UNKNOWN, error: true };
  const cached = useAgentTasks.getState().briefs[`${request.taskId}:${request.version}`];
  const [policy, brief, ci] = await Promise.allSettled([
    getTaskAutonomy(request.policyTaskId, signal),
    cached ? Promise.resolve(cached) : (async () => {
      const result = await client.from("task_briefs").select("done_when").eq("task_id", request.taskId)
        .eq("version", request.version).abortSignal(signal).maybeSingle();
      if (result.error || !result.data) throw new Error("Review criteria unavailable");
      return result.data as Pick<BriefRow, "done_when">;
    })(),
    request.job ? (async () => {
      const result = await client.rpc("job_ci_status", { p_task_id: request.taskId }).abortSignal(signal);
      if (result.error || !result.data) throw new Error("Review checks unavailable");
      return result.data as JobCiStatus;
    })() : Promise.resolve(null),
  ]);
  const ownCriteria = brief.status === "fulfilled" ? personCriteria(brief.value) : null;
  const jobCi = ci.status === "fulfilled" ? ci.value : null;
  const childCriteria = request.job ? jobCi?.pending_human : [];
  return {
    value: {
      autonomy: policy.status === "fulfilled" ? policy.value.level : null,
      personCriteria: ownCriteria === true || !!childCriteria?.length ? true
        : ownCriteria === false && childCriteria !== undefined ? false : null,
      ciState: jobCi?.state ?? null,
    },
    error: policy.status === "rejected" || brief.status === "rejected" || ci.status === "rejected"
      || ownCriteria === null || childCriteria === undefined,
  };
}

// Keep the limit across effect restarts: obsolete in-flight reads still occupy a
// slot until they settle. Switching views stops queued work immediately.
function limitedReads() {
  let running = 0;
  const queue: (() => void)[] = [];
  return (read: () => Promise<void>) => {
    const run = () => {
      running++;
      void read().finally(() => { running--; queue.shift()?.(); });
    };
    if (running < 3) run(); else queue.push(run);
  };
}

function taskRevision(task: TaskRow | undefined): unknown {
  return task ? [task.id, task.brief_version, task.state, task.review_state, task.acceptance, task.closed_by,
    task.delegate_agent_id, task.updated_at, task.last_activity_at] : null;
}

/** Reads presentation facts only. Actual acceptance and closure stay with server RPCs. */
export function useProgressReviewContext({ tasks, allTasks, agents, workspaceId, userId, active }: {
  tasks: TaskRow[]; allTasks: Record<string, TaskRow>; agents: AgentRow[];
  workspaceId: string; userId: string; active: boolean;
}) {
  const briefs = useAgentTasks((state) => state.briefs);
  const jobCi = useAgentTasks((state) => state.jobCi);
  const autonomyVersion = useSyncExternalStore(subscribeWorkspaceAutonomy, workspaceAutonomyVersion);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);
  const [cache] = useState(() => new Map<string, CachedReview>());
  const [limit] = useState(limitedReads);
  const [values, setValues] = useState<Record<string, CachedReview>>({});
  // Stable descriptors avoid requests on unrelated renders. One cache entry per
  // currently visible task replaces its older revision; filtered-out entries are pruned.
  const requestKey = JSON.stringify([...new Map(tasks.filter((task) => task.state === "ready_for_review" && !task.request_kind)
    .map((task) => [task.id, task])).values()].map((task): ReviewRequest => {
      const policyTaskId = task.parent_task_id ?? task.id;
      const policyTask = allTasks[policyTaskId];
      const agent = agents.find((item) => item.id === policyTask?.delegate_agent_id && item.workspace_id === workspaceId);
      return {
        taskId: task.id, policyTaskId, version: task.brief_version, job: !task.parent_task_id, workspaceId, userId,
        revision: JSON.stringify([workspaceId, userId, taskRevision(task), taskRevision(policyTask), agent?.autonomy, agent?.updated_at,
          autonomyVersion, refreshVersion, briefs[`${task.id}:${task.brief_version}`]?.done_when, jobCi[task.id],
          !task.parent_task_id ? Object.values(allTasks).filter((child) => child.parent_task_id === task.id).map(taskRevision) : null]),
      };
    }));
  const requests = useMemo(() => JSON.parse(requestKey) as ReviewRequest[], [requestKey]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => setRefreshVersion((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active]);

  useEffect(() => {
    // A remote policy change need not change the task row. Revalidate when this
    // view returns, even if the browser never lost focus while Table was open.
    if (!active) { cache.clear(); return; }
    const wanted = new Map(requests.map((request) => [request.taskId, request]));
    for (const [id, value] of cache) if (value.revision !== wanted.get(id)?.revision) cache.delete(id);
    const controller = new AbortController();
    let current = true;
    for (const request of requests) {
      if (cache.has(request.taskId)) continue;
      limit(async () => {
        if (!current || !sameScope(request)) return;
        let result: ReviewResult;
        try { result = await readReview(request, controller.signal); }
        catch { result = { value: UNKNOWN, error: true }; }
        if (!current || !sameScope(request)) return;
        cache.set(request.taskId, { ...result, revision: request.revision });
        setValues(Object.fromEntries(cache));
      });
    }
    return () => { current = false; controller.abort(); };
  }, [requests, active, cache, limit, retryVersion]);

  const current = Object.fromEntries(requests.flatMap((request) => {
    const result = values[request.taskId];
    return result?.revision === request.revision && cache.get(request.taskId) === result ? [[request.taskId, result] as const] : [];
  }));
  return {
    contexts: Object.fromEntries(requests.map((request) => {
      const brief = briefs[`${request.taskId}:${request.version}`];
      return [request.taskId, current[request.taskId]?.value ?? {
        ...UNKNOWN, personCriteria: brief ? personCriteria(brief) : null,
      }];
    })),
    loading: active && requests.some((request) => !current[request.taskId]),
    error: Object.values(current).some((result) => result.error),
    retry: () => {
      for (const [id, value] of cache) if (value.error) cache.delete(id);
      setValues(Object.fromEntries(cache));
      setRetryVersion((value) => value + 1);
    },
  };
}
