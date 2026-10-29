import { afterEach, describe, expect, it, vi } from "vitest";
import { continuityFrom, continuityText } from "@/lib/agentContinuity";
import { lastCheckpointFor, type ActivityRow } from "@/lib/agentTasks";
import { activityLabel } from "@/lib/agentTaskText";

const act = (seq: number, type: ActivityRow["type"], body: Record<string, unknown>, created_at = "2026-10-30T10:00:00Z"): ActivityRow =>
  ({ id: `a${seq}`, task_id: "t1", run_id: "r1", seq, type, body, ephemeral: false, author_type: "agent", author_id: "agent-1", created_at });

describe("task continuity", () => {
  afterEach(() => vi.useRealTimers());
  it("says the agent can continue from the last checkpoint, with harness and time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:05:00Z"));
    const info = continuityFrom({ capabilities: { resume: true } }, act(12, "checkpoint", { v: 1, next_step: "Email the team", harness: "claude_code", handover: true }));
    expect(info).toEqual({ resume: true, checkpoint: { seq: 12, created_at: "2026-10-30T10:00:00Z", harness: "claude_code", next_step: "Email the team", handover: true } });
    expect(continuityText(info!)).toBe("Can continue from checkpoint #12 (claude_code, 5m ago)");
  });
  it("says a run without the capability starts from the brief and the activity", () => {
    expect(continuityText(continuityFrom({ capabilities: {} }, null)!)).toBe("No checkpoints: a new run starts from the brief and the activity");
    expect(continuityText(continuityFrom({ capabilities: { resume: true } }, null)!)).toBe("Can continue from a checkpoint; none saved yet");
    expect(continuityFrom(null, null)).toBeNull();
  });
  it("labels checkpoint and handover activities", () => {
    expect(activityLabel(act(3, "checkpoint", { v: 1, next_step: "Email the team" }))).toBe("checkpoint: Email the team");
    expect(activityLabel(act(4, "handover", { from_harness: "claude_code", to_harness: "codex", summary: "1 approval pending." })))
      .toBe("handed over from claude_code to codex: 1 approval pending.");
  });
  it("lastCheckpointFor returns the newest checkpoint", () => {
    expect(lastCheckpointFor([act(1, "checkpoint", { v: 1, next_step: "a" }), act(2, "action", {}), act(5, "checkpoint", { v: 1, next_step: "b" })])?.seq).toBe(5);
    expect(lastCheckpointFor([])).toBeNull();
    expect(lastCheckpointFor(undefined)).toBeNull();
  });
});
