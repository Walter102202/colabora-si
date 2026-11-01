import type { AgentRow, AgentRole } from "@/lib/agentsStore";
import type { ConnectionRow } from "@/lib/agentConnect";
import { CONNECT_AGENT_NAMES } from "@/lib/agentConnectCatalog";

export interface JobAgent { id: string; name: string; logo: string | null; role: AgentRole; }
export interface JobSentence { agentId: string; name: string; logo: string | null; text: string; isLead: boolean; }
export interface JobReadyData { lines: JobSentence[]; sayThis: string; readyNote: string; planText: string; waitingText: string; }
export const JOB_ACCESS_NOTE = "Choosing an agent gives it access to this database. It can see every job here, not only this one.";

export function eligibleJobAgents(
  agents: Pick<AgentRow, "id" | "name" | "role" | "status" | "is_platform" | "revoked_at">[],
  connections: Pick<ConnectionRow, "agent_id" | "verified_at">[],
): JobAgent[] {
  return agents.filter((agent) => !agent.is_platform && !agent.revoked_at && agent.status === "enabled"
    && connections.some((connection) => connection.agent_id === agent.id && connection.verified_at))
    .map((agent) => {
      const catalogId = Object.entries(CONNECT_AGENT_NAMES).find(([, name]) => name.toLowerCase() === agent.name.toLowerCase())?.[0];
      return { id: agent.id, name: agent.name, role: agent.role, logo: catalogId ? `/brand/agents/${catalogId}.svg` : null };
    });
}

export function jobAgentNames(names: string[]): string {
  return names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export function jobReadyPanel({ title, lead, workers, subtaskCount, hasPlan }: {
  title: string; lead: JobAgent; workers: JobAgent[]; subtaskCount: number; hasPlan: boolean;
}): JobReadyData {
  const crew = workers.filter((agent, i) => agent.id !== lead.id && workers.findIndex((candidate) => candidate.id === agent.id) === i);
  return {
    lines: [
      { agentId: lead.id, name: lead.name, logo: lead.logo, isLead: true,
        text: `Work on ${title} as Lead` + (crew.length ? `, with ${jobAgentNames(crew.map((agent) => agent.name))} as ${crew.length > 1 ? "workers" : "worker"}` : "") },
      ...crew.map((agent) => ({ agentId: agent.id, name: agent.name, logo: agent.logo, isLead: false, text: `Work on ${title} as worker` })),
    ],
    sayThis: crew.length ? "Say this to each agent, in its own session." : "Say this to the Lead, in its own session.",
    waitingText: `Waiting for ${lead.name}. This page updates when it arrives.`,
    readyNote: `Nothing starts until ${lead.name} arrives. It ` + (subtaskCount ? "keeps your subtasks and writes the rest."
      : "writes the subtasks and " + (crew.length ? "shares them out." : "does them itself.")),
    planText: hasPlan ? "The plan is on this job’s page." : "The plan goes on this job’s page, or give it to the Lead in the chat.",
  };
}
