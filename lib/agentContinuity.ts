import type { ActivityRow } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

export interface ContinuityInfo {
  resume: boolean;
  checkpoint: { seq: number; created_at: string; harness: string | null; next_step: string; handover: boolean } | null;
}

// `checkpoint` is undefined while the activities are still loading: nothing is said until they are known.
export function continuityFrom(agent: { capabilities: Record<string, boolean> } | null, checkpoint: ActivityRow | null | undefined): ContinuityInfo | null {
  if (!agent || checkpoint === undefined) return null;
  return { resume: agent.capabilities.resume === true, checkpoint: checkpoint ? {
    seq: checkpoint.seq, created_at: checkpoint.created_at,
    harness: typeof checkpoint.body.harness === "string" ? checkpoint.body.harness : null,
    next_step: typeof checkpoint.body.next_step === "string" ? checkpoint.body.next_step : "",
    handover: checkpoint.body.handover === true,
  } : null };
}

export function continuityText(info: ContinuityInfo): string {
  if (!info.resume) {
    return info.checkpoint
      ? `Checkpoint #${info.checkpoint.seq} saved, but this agent starts from the brief and the activity`
      : "No checkpoints: a new run starts from the brief and the activity";
  }
  if (!info.checkpoint) return "Can continue from a checkpoint; none saved yet";
  const cp = info.checkpoint;
  return `Can continue from checkpoint #${cp.seq} (${cp.harness ?? "unknown harness"}, ${formatRelative(Date.parse(cp.created_at))})`;
}

export function handoverLabel(a: ActivityRow): string {
  return `handed over from ${String(a.body.from_harness ?? "another session")} to ${String(a.body.to_harness ?? "another session")}: ${String(a.body.summary ?? "")}`;
}
