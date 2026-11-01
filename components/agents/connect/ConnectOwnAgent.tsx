import type { AgentRole } from "@/lib/agentsStore";

export interface ConnectOwnAgentProps {
  name: string; role: AgentRole; busy?: boolean; error?: string | null;
  onName: (name: string) => void; onRole: (role: AgentRole) => void; onCreate?: () => void;
}
export function ConnectOwnAgent({ name, role, busy, error, onName, onRole, onCreate }: ConnectOwnAgentProps) {
  return <form onSubmit={(event) => { event.preventDefault(); if (!busy) onCreate?.(); }}>
    <div className="space-y-4 bg-bg-secondary p-5 text-sm">
      <label className="block">Agent name<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-bg px-3" maxLength={80} value={name} onChange={(event) => onName(event.target.value)} /></label>
      <label className="block">Role<select className="mt-1 min-h-11 w-full rounded-md border border-border bg-bg px-3" value={role} onChange={(event) => onRole(event.target.value as AgentRole)}><option value="worker">Worker</option><option value="lead">Lead</option></select></label>
      <p className="text-text-secondary">{role === "worker" ? "Works on the tasks it is given." : "Creates tasks, delegates them to other agents and reviews their work."}</p>
      <div><p className="text-xs text-text-secondary">Page access</p><p className="font-medium">Getting started</p><p className="text-text-secondary">We’ll create this shared page for you and your agent.</p></div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
    <div className="p-3"><button data-setup-action type="submit" disabled={busy || !onCreate || !name.trim() || name.trim().length > 80} className="min-h-11 w-full rounded-lg bg-accent px-4 font-semibold text-white disabled:opacity-50">{busy ? "Creating…" : "Create agent token"}</button></div>
  </form>;
}
