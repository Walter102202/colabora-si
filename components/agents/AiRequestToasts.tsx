import { useEffect, useState } from "react";
import { useAiRequests } from "@/lib/agentAiRequests";
import { loadTaskDiff, revertRun, sendMessage } from "@/lib/agentActions";

export function AiRequestToasts({ pageId }: { pageId: string }) {
  const requests = useAiRequests(pageId);
  const [dismissed, setDismissed] = useState<string[]>([]), [undone, setUndone] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const [stopping, setStopping] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const undo = async (taskId: string, runId: string, blockId: string, meeting = false) => {
    setBusy(taskId); setError("");
    try {
      const keys = meeting ? (await loadTaskDiff(taskId)).runs.find(r => r.run_id === runId)?.items
        .filter(i => i.kind === "block" && i.change === "added" && i.page_id === pageId).map(i => i.key) ?? [] : [`block:${pageId}:${blockId}`];
      if (!keys.length) throw new Error("No summary blocks are available to undo.");
      await revertRun(taskId, runId, keys); setUndone((ids) => [...ids, taskId]);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const cancel = async (taskId: string) => {
    setBusy(taskId); setError("");
    try { await sendMessage(taskId, "Cancel AI request", "stop"); setStopping((ids) => [...ids, taskId]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  return <div aria-label="AI requests">{requests.filter((r) => (r.kind !== "fill" || r.state !== "done") && !dismissed.includes(r.id)
    && (!r.closedAt || now - Date.parse(r.closedAt) < 600_000)).map((r) => <div role="status" key={r.id} className="my-2 rounded bg-bg-secondary p-2 text-sm">
    {r.state === "done" ? <>{undone.includes(r.id) ? (r.kind === "meeting" ? "Meeting summary undone." : "Rewrite undone.") : (r.kind === "meeting" ? "Meeting summary ready" : "Rewritten by Colabora")}{r.runId && r.request.block_id && !undone.includes(r.id)
      && <button className="ml-2 text-accent" disabled={busy === r.id} onClick={() => void undo(r.id, r.runId!, r.request.block_id!, r.kind === "meeting")}>Undo</button>}</>
      : r.state === "failed" || r.state === "cancelled" ? (r.kind === "meeting" ? "Trama could not summarize this meeting." : r.kind === "rewrite" ? "Colabora could not rewrite this block." : "Colabora could not complete this fill.")
      : stopping.includes(r.id) ? "Cancelling…" : r.kind === "meeting" ? "Trama is summarizing the meeting…" : r.kind === "rewrite" ? "Colabora is rewriting…" : "Colabora is filling…"}
    {!["done", "failed", "cancelled"].includes(r.state) && <button className="ml-2" disabled={busy === r.id || stopping.includes(r.id)} onClick={() => void cancel(r.id)}>Cancel</button>}
    {["done", "failed", "cancelled"].includes(r.state) && <button className="ml-2" onClick={() => setDismissed((ids) => [...ids, r.id])}>Dismiss</button>}
  </div>)}{error && <p role="alert">{error}</p>}</div>;
}
