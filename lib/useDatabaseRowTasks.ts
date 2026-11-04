import { useEffect, useState } from "react";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import { mergeRows, useAgentTasks, type TaskRow } from "@/lib/agentTasks";
import { useStore } from "@/lib/store";
import type { DbRow } from "@/lib/types";

const unresolved = new Set<string>();

// The workspace task feed pages through closed history. Resolve this board's rows
// together before treating a missing task as an unassigned job.
export function useDatabaseRowTasks(rows: DbRow[] | undefined) {
  const workspaceId = useStore((state) => state.syncWorkspaceId);
  const client = rows?.length && workspaceId ? getAgentClient() : null;
  const key = client && rows ? JSON.stringify(rows.map((row) => row.pageId)) : "";
  const [result, setResult] = useState<{ workspaceId: string; ids: Set<string> }>();
  const [failure, setFailure] = useState<{ workspaceId: string; key: string; message: string }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!client || !workspaceId) return;
    return useAgentTasks.getState().subscribe(workspaceId);
  }, [client, workspaceId]);

  useEffect(() => {
    if (!client || !workspaceId) return;
    const controller = new AbortController();
    const ids = JSON.parse(key) as string[];
    const load = async () => {
      const store = useAgentTasks.getState;
      // Bound IN-filter URLs on large boards. Page through multiple task
      // histories for a row if they exceed the API response limit.
      for (let start = 0; start < ids.length; start += 100) {
        const pages = ids.slice(start, start + 100);
        let cursor = "";
        while (!controller.signal.aborted) {
          const before = store().tasks;
          let query = client.from("agent_tasks").select("*").eq("workspace_id", workspaceId)
            .in("row_page_id", pages).is("request_kind", null).order("id").limit(500);
          if (cursor) query = query.gt("id", cursor);
          const response = await query.abortSignal(controller.signal);
          if (controller.signal.aborted || store().workspaceId !== workspaceId) return;
          if (response.error) throw response.error;
          // A realtime change (including deletion) or workspace refresh won
          // the race. Read this page again before adding it to the shared store.
          if (store().tasks !== before) continue;
          const tasks = response.data as TaskRow[];
          if (tasks.length) useAgentTasks.setState({ tasks: mergeRows(before, tasks) });
          if (tasks.length < 500) break;
          cursor = tasks[tasks.length - 1].id;
        }
      }
      if (!controller.signal.aborted) {
        setFailure(undefined);
        setResult({ workspaceId, ids: new Set(ids) });
      }
    };
    void load().catch((cause: unknown) => {
      if (!controller.signal.aborted) setFailure({ workspaceId, key, message: agentErrorMessage(cause) });
    });
    return () => controller.abort();
  }, [client, workspaceId, key, attempt]);

  const knownIds = result && result.workspaceId === workspaceId ? result.ids : unresolved;
  return {
    resolved: client ? knownIds : null,
    error: failure?.workspaceId === workspaceId && failure?.key === key ? failure.message : null,
    retry: () => { setFailure(undefined); setAttempt((value) => value + 1); },
  };
}
