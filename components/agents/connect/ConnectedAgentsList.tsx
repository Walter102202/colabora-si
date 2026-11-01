import { Bot } from "lucide-react";
import type { ConnectedRow } from "@/lib/agentConnect";
import { CONNECT_URL, pageUrl, settingsUrl } from "@/lib/routes";

const STATUS = { connected: "Connected", waiting: "Waiting for first read", manual: "Added in Settings" };
export function ConnectedAgentsList({ rows, pages, canConnect, error, loading }: {
  rows: ConnectedRow[]; pages: Record<string, { title: string; isDeleted?: boolean }>;
  canConnect: boolean; error: boolean; loading: boolean;
}) {
  return <div className="mx-auto w-full max-w-[760px] px-6 py-10">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">Connected agents</h1><p className="mt-2 text-sm text-text-secondary">Agents linked to this workspace, and the page they started on.</p></div>
      {canConnect ? <a href={CONNECT_URL} className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white">Connect an agent</a> : null}
    </div>
    {error ? <p role="alert" className="mt-6 text-sm">We couldn’t load your agents. Try again.</p> : null}
    {loading ? <div className="mt-6 h-16 animate-pulse rounded-lg bg-bg-secondary" aria-busy="true" /> : rows.length ? <ul className="mt-6 divide-y divide-border rounded-xl border border-border">
      {rows.map((row) => {
        const page = row.pageId ? pages[row.pageId] : null;
        return <li key={row.agentId} className="flex items-start gap-3 p-5">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border ${row.logo ? "bg-white" : "bg-bg-secondary"}`}>
            {row.logo ? <img src={row.logo} alt="" className="h-7 w-7 object-contain" /> : <Bot size={28} aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1"><h2 className="break-words font-semibold">{row.name}</h2><p className="mt-1 text-sm text-text-secondary">{STATUS[row.status]}</p>
            {row.status === "connected" && row.since ? <p className="mt-1 text-xs text-text-secondary">Connected <time dateTime={row.since}>{new Date(row.since).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}</time></p> : null}
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-accent">
              {row.pageId && page && !page.isDeleted ? <a href={pageUrl(row.pageId)}>Open {page.title}</a> : null}
              <a href={settingsUrl("agents")}>Manage access</a>
            </div>
          </div>
        </li>;
      })}
    </ul> : !error ? <div className="mt-8 rounded-xl border border-border p-6"><p>No agents connected yet.</p><p className="mt-2 text-sm text-text-secondary">Connect one to start working together.</p></div> : null}
  </div>;
}
