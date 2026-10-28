import { WAITING_REASON_LABEL, type WaitingItem, type WaitingListData } from "@/lib/agentCard";
import { TASK_STATE_LABEL } from "@/lib/agentState";
import { expiresIn } from "@/lib/agentTaskText";
import { formatRelative } from "@/lib/utils";

// Compact list of the tasks that wait on the person (list_waiting_on_me).
// Pure: "Show" loads the task card in place, "Open" goes to the app.
export function WaitingList({
  data,
  busy,
  onShow,
  onOpen,
}: {
  data: WaitingListData;
  busy: string | null;
  onShow: (item: WaitingItem) => void;
  onOpen: ((item: WaitingItem) => void) | null;
}) {
  if (data.items.length === 0) return <p className="text-xs text-text-tertiary">Nothing is waiting on you.</p>;
  return (
    <section aria-label="Tasks waiting on you" className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Waiting on you · {data.items.length}</h3>
      <ul className="divide-y divide-border rounded-md border border-border">
        {data.items.map((item) => (
          <li key={item.task_id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{item.title || "Untitled task"}</p>
              <p className="text-xs text-text-secondary">
                {WAITING_REASON_LABEL[item.reason]}
                {item.approval?.question ? `: ${item.approval.question}` : ""}
              </p>
              <p className="text-xs text-text-tertiary">
                {TASK_STATE_LABEL[item.state]} · {item.agent_name ?? "no agent"}
                {item.last_activity_at ? ` · ${formatRelative(Date.parse(item.last_activity_at))}` : ""}
                {item.approval ? ` · expires in ${expiresIn(item.approval.expires_at)}` : ""}
              </p>
            </div>
            <button type="button" className="rounded bg-accent px-2 py-1 text-xs text-white disabled:opacity-50" disabled={busy !== null} onClick={() => onShow(item)}>
              {busy === item.task_id ? "Opening…" : "Show"}
            </button>
            {onOpen && (
              <a className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" href={item.url} onClick={(e) => { e.preventDefault(); onOpen(item); }}>
                Open in app
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
