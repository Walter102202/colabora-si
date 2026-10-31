import { useEffect, useState } from "react";
import { releaseEnvironment } from "@/lib/agentActions";
import { getAgentClient, agentErrorMessage } from "@/lib/agentClient";
import type { EnvironmentResource } from "@/lib/agentTasks";
import { taskUrl } from "@/lib/routes";
import { EnvironmentCard } from "@/components/agents/panel/EnvironmentCard";

type ResourceRow = EnvironmentResource & { task_id: string; task: { title: string; row_page_id: string } | null };

export function EnvironmentList({ workspaceId }: { workspaceId: string | null }) {
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [releasing, setReleasing] = useState<string | null>(null);
  const confirmStopped = async (taskId: string) => {
    setReleasing(taskId);
    setError(null);
    try {
      await releaseEnvironment(taskId);
      setRefresh((n) => n + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setReleasing(null); }
  };
  useEffect(() => {
    const client = getAgentClient();
    if (!client || !workspaceId) return;
    let alive = true;
    void client.from("agent_resources").select("kind,value,status,task_id,task:agent_tasks(title,row_page_id)")
      .eq("workspace_id", workspaceId).neq("status", "released").order("created_at", { ascending: true })
      .then(({ data, error: failure }) => {
        if (!alive) return;
        setError(failure ? agentErrorMessage(failure) : null);
        setRows(failure ? [] : (data as unknown as ResourceRow[]));
      });
    return () => { alive = false; };
  }, [workspaceId, refresh]);
  if (!workspaceId) return null;
  const groups = new Map<string, ResourceRow[]>();
  for (const row of rows) groups.set(row.task_id, [...(groups.get(row.task_id) ?? []), row]);
  return <section className="space-y-3 border-t border-border pt-4" aria-label="Environments in use">
    <div className="flex items-center justify-between">
      <h3 className="font-medium">Environments in use</h3>
      <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => setRefresh((n) => n + 1)}>Refresh environments</button>
    </div>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>
      : !rows.length && <p className="text-sm text-text-secondary">No environments are held.</p>}
    {[...groups].map(([taskId, items]) => <div key={taskId} className="space-y-2 rounded border border-border p-3">
      {items[0].task && <a className="text-sm text-accent underline" href={taskUrl(items[0].task.row_page_id, taskId)}>{items[0].task.title || "Open task"}</a>}
      <EnvironmentCard environment={items} />
      {items.some((item) => item.status === "releasing") && <div className="space-y-1">
        <p className="text-xs text-text-secondary">Stop these resources first, then confirm they are available for another task.</p>
        <button type="button" disabled={releasing !== null} aria-busy={releasing === taskId}
          className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" onClick={() => void confirmStopped(taskId)}>Confirm stopped</button>
      </div>}
    </div>)}
  </section>;
}
