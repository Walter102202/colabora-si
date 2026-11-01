import { Bot, LockKeyhole, PauseCircle } from "lucide-react";
import type { ConnectedRow } from "@/lib/agentConnect";
import type { AgentRole } from "@/lib/agentsStore";
import { AUTONOMY_HELP, AUTONOMY_LABEL, AUTONOMY_LEVELS, type AutonomyLevel, type AutonomyPolicy } from "@/lib/agentAutonomy";
import { agentEffect } from "@/lib/agentRoles";
import { CONNECT_URL, pageUrl, settingsUrl } from "@/lib/routes";

const STATUS = { connected: "Connected", waiting: "Waiting for first read", manual: "Added in Settings" };
const OWNER_NOTE = "Only the workspace owner can change roles and autonomy.";
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export function ConnectedAgentsList({ rows, pages, canConnect, error, loading, policy, saving, errors, onRoleChange, onAutonomyChange, onWorkspaceChange }: {
  rows: ConnectedRow[]; pages: Record<string, { title: string; isDeleted?: boolean }>;
  canConnect: boolean; error: boolean; loading: boolean; policy: AutonomyPolicy | null;
  saving: Record<string, boolean>; errors: Record<string, string | null>;
  onRoleChange: (row: ConnectedRow, role: AgentRole) => void;
  onAutonomyChange: (row: ConnectedRow, level: AutonomyLevel | null) => void;
  onWorkspaceChange: (level: AutonomyLevel) => void;
}) {
  const stopped = policy?.level === "ask", canEdit = policy?.can_edit === true;
  return <div className="mx-auto w-full min-w-0 max-w-[760px] px-6 pt-10 pb-32">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">Connected agents</h1><p className="mt-2 text-sm text-text-secondary">Agents linked to this workspace, and the page they started on.</p></div>
      {canConnect ? <a href={CONNECT_URL} className={`inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white ${focus}`}>Connect an agent</a> : null}
    </div>
    {policy && <section aria-label="Workspace autonomy" aria-busy={saving.workspace || undefined} className={`mt-6 rounded-xl border px-4 py-3.5 text-sm ${stopped ? "border-[var(--c-yellow)] bg-[var(--bgc-yellow)]" : "border-border bg-bg-secondary"}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 font-semibold">{stopped && <PauseCircle size={17} aria-hidden="true" className="text-[var(--c-yellow)]" />}<span>{stopped ? "Every agent is stopped" : "Workspace default"}</span></div>
        {canEdit ? <select aria-label="Workspace default" value={policy.level} disabled={saving.workspace} onChange={(event) => onWorkspaceChange(event.target.value as AutonomyLevel)} className={`min-h-9 max-w-full rounded-md border border-border bg-bg px-2 text-text ${focus}`}>
          {AUTONOMY_LEVELS.map((level) => <option key={level} value={level}>{AUTONOMY_LABEL[level]}</option>)}
        </select> : <span className="font-medium">{AUTONOMY_LABEL[policy.level]}</span>}
      </div>
      <p className={`mt-1 text-[13px] ${stopped ? "text-[var(--c-yellow)]" : "text-text-secondary"}`}>{stopped ? "This workspace is at Ask first, so every agent stops and asks a person, whatever its own level." : AUTONOMY_HELP[policy.level]}</p>
      {errors.workspace && <p role="alert" className="mt-2 text-sm text-[var(--c-red)]">{errors.workspace}</p>}
    </section>}
    {policy && !canEdit && <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary"><LockKeyhole size={15} aria-hidden="true" className="shrink-0" />{OWNER_NOTE}</p>}
    {error ? <p role="alert" className="mt-6 text-sm">We couldn’t load your agents. Try again.</p> : null}
    {loading ? <div className="mt-6 h-16 animate-pulse rounded-lg bg-bg-secondary" aria-busy="true" /> : rows.length ? <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
      {rows.map((row) => {
        const page = row.pageId ? pages[row.pageId] : null;
        const effect = policy ? agentEffect(row, rows, policy.level) : null;
        const defaultLabel = `Workspace default (${policy ? AUTONOMY_LABEL[policy.level] : "…"})`;
        return <li key={row.agentId} className="flex flex-wrap items-start gap-x-6 gap-y-4 p-5">
          <div className="flex min-w-0 flex-[1_1_260px] items-start gap-3">
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border ${row.logo ? "bg-bg" : "bg-bg-secondary"}`}>
              {row.logo ? <img src={row.logo} alt="" className="h-7 w-7 object-contain" /> : <Bot size={28} aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1"><h2 className="break-words font-semibold">{row.name}</h2><p className="mt-1 text-sm text-text-secondary">{STATUS[row.status]}</p>
              {row.status === "connected" && row.since ? <p className="mt-1 text-xs text-text-secondary">Connected <time dateTime={row.since}>{new Date(row.since).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}</time></p> : null}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-accent">
                {row.pageId && page && !page.isDeleted ? <a className={`hover:underline ${focus}`} href={pageUrl(row.pageId)}>Open {page.title}</a> : null}
                <a className={`hover:underline ${focus}`} href={settingsUrl("agents")}>Manage access</a>
              </div>
            </div>
          </div>
          <div aria-busy={saving[row.agentId] || undefined} className="grid min-w-0 flex-[0_1_312px] grid-cols-[68px_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="text-text-secondary">Role</span>
            {canEdit ? <div role="group" aria-label={`Role of ${row.name}`} className="flex gap-0.5 rounded-md border border-border bg-bg-secondary p-0.5">
              {(["lead", "worker"] as const).map((role) => <button key={role} type="button" aria-pressed={row.role === role} disabled={saving[row.agentId]} onClick={() => onRoleChange(row, role)} className={`min-h-[30px] flex-1 rounded px-2 disabled:opacity-60 ${focus} ${row.role === role ? "bg-bg font-semibold shadow-sm" : "hover:bg-[var(--bg-hover)]"}`}>{role === "lead" ? "Lead" : "Worker"}</button>)}
            </div> : <span className="font-medium">{row.role === "lead" ? "Lead" : "Worker"}</span>}
            <span /><span className="text-[13px] text-text-secondary">{row.role === "lead" ? "Leads and can also work" : "Only works"}</span>
            <label htmlFor={`autonomy-${row.agentId}`} className="mt-2 text-text-secondary">Autonomy</label>
            {canEdit ? <select id={`autonomy-${row.agentId}`} aria-label={`Autonomy of ${row.name}`} value={row.autonomy ?? "workspace"} disabled={saving[row.agentId]} onChange={(event) => onAutonomyChange(row, event.target.value === "workspace" ? null : event.target.value as AutonomyLevel)} className={`mt-2 min-h-9 w-full min-w-0 rounded-md border border-border bg-bg px-1.5 text-text disabled:opacity-60 ${focus}`}>
              <option value="workspace">{defaultLabel}</option>
              {AUTONOMY_LEVELS.map((level) => <option key={level} value={level}>{AUTONOMY_LABEL[level]}</option>)}
            </select> : <span id={`autonomy-${row.agentId}`} className="mt-2 font-medium">{row.autonomy ? AUTONOMY_LABEL[row.autonomy] : defaultLabel}</span>}
            {effect && <><span /><span className={`mt-0.5 text-[13px] ${stopped ? "text-[var(--c-yellow)]" : "text-accent"}`}>{effect}</span></>}
            {errors[row.agentId] && <p role="alert" className="col-span-2 mt-2 text-sm text-[var(--c-red)]">{errors[row.agentId]}</p>}
          </div>
        </li>;
      })}
    </ul> : !error ? <div className="mt-8 rounded-xl border border-border p-6"><p>No agents connected yet.</p><p className="mt-2 text-sm text-text-secondary">Connect one to start working together.</p></div> : null}
    {policy && <ul className="mt-4 grid gap-1 px-1 text-[13px] text-text-secondary"><li>A Worker never has more autonomy than its Lead.</li><li>Payments always ask, at every level.</li>{canEdit && <li>{OWNER_NOTE}</li>}</ul>}
  </div>;
}
