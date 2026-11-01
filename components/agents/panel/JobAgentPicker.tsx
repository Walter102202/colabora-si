import { Check, KeyRound, X } from "lucide-react";
import { JOB_ACCESS_NOTE, type JobAgent } from "@/lib/agentJobs";

export interface JobAgentPickerProps {
  kind: "lead" | "workers";
  agents: JobAgent[];
  selectedIds: string[];
  leadId?: string;
  busy?: boolean;
  blockedAgentIds?: string[];
  lockedIds?: string[];
  onChoose: (id: string) => void;
  onClose: () => void;
  connectHref: string;
  agentsHref: string;
}

export function JobAgentPicker({ kind, agents, selectedIds, leadId, busy = false, blockedAgentIds = [], lockedIds = [], onChoose, onClose, connectHref, agentsHref }: JobAgentPickerProps) {
  const choices = agents.filter((agent) => kind === "lead" ? agent.role === "lead" : agent.id !== leadId);
  const title = kind === "lead" ? "Lead for this job" : "Who works with the Lead";
  return (
    <div role="dialog" aria-label={title}
      className="w-[340px] max-w-full rounded-lg border border-border bg-bg p-1 text-sm text-text shadow-xl">
      <div className="flex items-start gap-2 px-2.5 pb-1.5 pt-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-[13px] text-text-secondary">{kind === "lead"
            ? "Writes the subtasks, assigns the work and reviews it. Only agents with the Lead role appear here."
            : "Optional. They go in your sentence, and the Lead shares out the subtasks."}</p>
        </div>
        <button type="button" aria-label="Close menu" onClick={onClose} className="rounded p-1 text-text-secondary hover:bg-bg-secondary"><X size={16} aria-hidden="true" /></button>
      </div>
      {choices.length === 0 && <p className="px-2.5 py-2 text-[13px] text-text-secondary">{kind === "lead"
        ? <>No connected agents have the Lead role. <a className="text-accent underline" href={agentsHref}>Change a role in Connected agents.</a></>
        : "No connected agents are available."}</p>}
      {choices.map((agent) => {
        const blocked = blockedAgentIds.includes(agent.id);
        return <div key={agent.id}>
          <button type="button" aria-pressed={selectedIds.includes(agent.id)} disabled={busy || blocked || lockedIds.includes(agent.id)} onClick={() => onChoose(agent.id)}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-bg-secondary disabled:opacity-50">
            {agent.logo ? <img src={agent.logo} alt="" width={24} height={24} className="size-6 shrink-0 object-contain" />
              : <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded border border-border text-xs">{agent.name.slice(0, 1)}</span>}
            <span className="min-w-0 flex-1 break-words font-medium">{agent.name}</span>
            {selectedIds.includes(agent.id) && <Check size={16} aria-hidden="true" />}
          </button>
          {blocked && <p className="px-2.5 pb-2 text-xs text-text-secondary">Ask the workspace owner to give {agent.name} access.</p>}
        </div>;
      })}
      <p className="m-1 flex items-start gap-2 rounded-md bg-bg-secondary p-2.5 text-[13px]"><KeyRound size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" /><span>{JOB_ACCESS_NOTE}</span></p>
      <a href={connectHref} className="flex min-h-9 items-center px-3.5 text-[13px] text-accent hover:underline">Connect another agent</a>
    </div>
  );
}
