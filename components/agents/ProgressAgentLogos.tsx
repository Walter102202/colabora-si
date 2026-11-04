import { Bot } from "lucide-react";
import Tooltip from "@/components/Tooltip";
import type { ProgressAgent } from "@/lib/agentProgress";

export function ProgressAgentLogos({ members, compact = false }: { members: ProgressAgent[]; compact?: boolean }) {
  if (!members.length) return null;
  return <span className={`task-progress-agents${compact ? " is-compact" : ""}`}>
    {members.map((member) => {
      const label = `${member.name} · ${member.role}`;
      const className = `task-progress-agent${member.role === "Lead" ? " is-lead" : ""}`;
      const logo = member.logo ? <img src={member.logo} alt="" width={20} height={20} draggable={false} /> : <Bot size={18} aria-hidden="true" />;
      return <Tooltip key={member.id} label={label} delay={200}>
        {compact ? <span role="img" aria-label={label} className={className}>{logo}</span>
          : <button type="button" aria-label={label} className={className}>{logo}</button>}
      </Tooltip>;
    })}
  </span>;
}
