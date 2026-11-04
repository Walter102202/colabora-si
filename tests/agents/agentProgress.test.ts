import { describe, expect, it } from "vitest";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import type { ApprovalRow, RunRow, TaskRow } from "@/lib/agentTasks";
import type { DbRow } from "@/lib/types";
import { parseProgressReadMarkers, progressActivityAt, progressAgentLogo, progressReadKey, progressRows, taskProgressState, updatedSinceRead, type ProgressReviewContext } from "@/lib/agentProgress";
import { progressTramaTask } from "@/lib/agentTramaContext";
import { TRAMA } from "@/lib/tramaIdentity";

const base = (mockCard("1") as TaskCardData).task;
const task = (patch: Partial<TaskRow> = {}): TaskRow => ({ ...base, id: "task", workspace_id: "workspace", db_page_id: "database", row_page_id: "page", owner_user_id: "person", state: "working", review_state: "none", acceptance: "pending", brief_stale: false, ...patch });
const row = (id: string, parentRowId?: string): DbRow => ({ id, pageId: `page-${id}`, cells: { title: id }, ...(parentRowId ? { parentRowId } : {}) });
const manual: ProgressReviewContext = { autonomy: "ask", personCriteria: false, ciState: "none" };

it("identifies logos from the saved harness, keeping custom names, platform identity and unknown providers distinct", () => {
  const logo = (name: string, harness?: unknown, platform = false) => progressAgentLogo({ name, connection: { harness }, is_platform: platform });
  expect(logo("Project lead", "claude_code")).toBe("/brand/agents/claude-code.svg");
  expect(logo("Codex worker", "codex")).toBe("/brand/agents/codex.svg");
  expect(logo("Claude Code", "muse_code")).toBe("/brand/agents/muse-code.svg");
  expect(logo("Reviewer", "claude-ai")).toBe("/brand/agents/claude.svg");
  expect(logo("Pages agent", "claude-code-workspace")).toBe("/brand/agents/claude-code.svg");
  expect(logo("Muse Code")).toBe("/brand/agents/muse-code.svg");
  expect(logo("Muse")).toBe("/brand/agents/muse.jpg");
  expect(logo("Trama", "agent", true)).toBe(TRAMA.src);
  for (const harness of ["custom-provider", "your-agent", "agent", "https://example.test/logo.svg"]) expect(logo("Claude Code", harness)).toBeNull();
  expect(logo("Custom helper")).toBeNull();
  expect(progressAgentLogo(undefined)).toBeNull();
});

describe("progress row inventory", () => {
  it("retains matching old and taskless rows, adds only their ancestors, and never mutates the source", () => {
    const parent = row("parent"), sibling = row("sibling", "parent"), child = row("child", "parent"), old = row("old"), excluded = row("excluded");
    const all = [parent, sibling, child, old, excluded], snapshot = structuredClone(all);
    const result = progressRows([child, old], all);
    const ids = result.map((entry) => entry.row.id);
    expect(new Set(ids)).toEqual(new Set(["old", "parent", "child"]));
    expect(ids.indexOf("parent")).toBeLessThan(ids.indexOf("child"));
    expect(result.find((entry) => entry.row.id === "parent")).toMatchObject({ depth: 0, ancestors: [], contextOnly: true });
    expect(result.find((entry) => entry.row.id === "child")).toMatchObject({ depth: 1, ancestors: ["parent"], contextOnly: false });
    expect(result.map((entry) => entry.row.id)).not.toContain("sibling");
    expect(all).toEqual(snapshot);
  });

  it("keeps every matching row reachable despite cycles, self-parents, missing parents and nested ancestors", () => {
    const all = [row("a", "b"), row("b", "a"), row("self", "self"), row("orphan", "missing"), row("root"), row("middle", "root"), row("leaf", "middle")];
    const result = progressRows(all, all, new Map(all.map((item, index) => [item.id, index]))), ids = result.map((entry) => entry.row.id);
    expect(new Set(ids).size).toBe(all.length);
    expect([...ids].sort()).toEqual(all.map((entry) => entry.id).sort());
    expect(result.find((entry) => entry.row.id === "orphan")?.depth).toBe(0);
    expect(result.find((entry) => entry.row.id === "leaf")?.ancestors).toEqual(["root", "middle"]);
    expect(result.every((entry) => !entry.ancestors.includes(entry.row.id))).toBe(true);
    expect(progressRows([], all)).toEqual([]);
  });

  it("orders recent job activity first while keeping siblings, filtered parents and saved rows intact", () => {
    const all = [row("older"), row("slow", "older"), row("fast", "older"), row("newer"), row("tie"), row("unknown")];
    const snapshot = structuredClone(all);
    const dates = new Map([["older", 1000], ["slow", 2000], ["fast", 9000], ["newer", 5000], ["tie", 5000], ["unknown", NaN]]);
    const entries = progressRows(all, all, dates);
    expect(entries.map((entry) => entry.row.id)).toEqual(["older", "fast", "slow", "newer", "tie", "unknown"]);
    expect(entries[0]).toMatchObject({ activityAt: 9000, depth: 0 });
    expect(entries[1]).toMatchObject({ activityAt: 9000, depth: 1, ancestors: ["older"] });
    const filtered = progressRows([all[2], all[3]], all, dates);
    expect(filtered.map((entry) => entry.row.id)).toEqual(["older", "fast", "newer"]);
    expect(filtered[0]).toMatchObject({ contextOnly: true, activityAt: 9000 });
    expect(all).toEqual(snapshot);
  });

  it("uses saved activity dates with update and creation fallbacks, leaving missing dates unknown", () => {
    expect(progressActivityAt(task({ last_activity_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T11:00:00Z" }))).toBe(Date.parse("2026-11-04T10:00:00Z"));
    expect(progressActivityAt(task({ last_activity_at: "invalid", updated_at: "2026-11-04T11:00:00Z" }))).toBe(Date.parse("2026-11-04T11:00:00Z"));
    expect(progressActivityAt(task({ last_activity_at: null, updated_at: "invalid", created_at: "2026-11-04T09:00:00Z" }))).toBe(Date.parse("2026-11-04T09:00:00Z"));
    expect(progressActivityAt(undefined)).toBeUndefined();
  });
});

describe("truthful task progress states", () => {
  it.each([
    ["done", "accepted", "Accepted", "success"],
    ["done", "rejected", "Closed", "neutral"],
    ["done", "pending", "Closed", "neutral"],
    ["failed", "pending", "Failed", "error"],
    ["cancelled", "pending", "Stopped", "neutral"],
  ] as const)("does not turn %s/%s into a successful delivery or a deployment", (state, acceptance, label, tone) => {
    const result = taskProgressState(task({ state, acceptance }), null, [], "person");
    expect(result).toMatchObject({ label, tone, needsYou: false });
    expect(result.detail).not.toMatch(/(?:merged|deployed|published|100%)/i);
  });

  it("distinguishes the owner's review from Lead review and another person's decision", () => {
    expect(taskProgressState(task({ state: "ready_for_review" }), null, [], "person", manual)).toMatchObject({ label: "Needs your review", needsYou: true });
    expect(taskProgressState(task({ state: "ready_for_review" }), null, [], "other", manual)).toMatchObject({ label: "Ready for review", needsYou: false });
    expect(taskProgressState(task({ parent_task_id: "parent", state: "ready_for_review", review_state: "pending" }), null, [], "person", manual)).toMatchObject({ label: "Waiting on Lead", needsYou: false });
    expect(taskProgressState(task({ parent_task_id: "parent", state: "ready_for_review", review_state: "approved" }), null, [], "person", manual)).toMatchObject({ label: "Waiting on Lead", needsYou: false });
  });

  it.each([
    ["pending", "Waiting for CI"], ["failed", "CI failed"], ["passed", "Waiting on Lead"],
    ["none", "Waiting on Lead"], ["no_commit", "Waiting on Lead"], ["not_connected", "Waiting on Lead"],
  ] as const)("does not turn autonomous %s work into a human decision or promise closure", (ciState, label) => {
    const result = taskProgressState(task({ state: "ready_for_review" }), null, [], "person", { autonomy: "autonomous", personCriteria: false, ciState });
    expect(result).toMatchObject({ label, needsYou: false });
    expect(result.detail).not.toMatch(/automatically|will close|accepted|running/i);
  });

  it("keeps a person's criteria visible while CI blocks acceptance and when autonomy is unknown", () => {
    for (const autonomy of ["autonomous", "ask", null] as const) {
      expect(taskProgressState(task({ state: "ready_for_review" }), null, [], "person", { autonomy, personCriteria: true, ciState: "pending" }))
        .toMatchObject({ label: "Needs your review", needsYou: true, detail: expect.stringContaining("waiting for CI") });
    }
    expect(taskProgressState(task({ state: "ready_for_review", review_state: "outdated" }), null, [], "person", { autonomy: "autonomous", personCriteria: true, ciState: "pending" }))
      .toMatchObject({ label: "Review outdated", needsYou: true });
  });

  it("does not invent a human requirement or hide an explicit approval when metadata is unknown", () => {
    for (const review of [undefined, { autonomy: null, personCriteria: null, ciState: null }, { autonomy: "autonomous", personCriteria: null, ciState: "pending" }] as (ProgressReviewContext | undefined)[]) {
      expect(taskProgressState(task({ state: "ready_for_review" }), null, [], "person", review)).toMatchObject({ label: "Ready for review", needsYou: false });
      const approval = { task_id: "task", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() } as ApprovalRow;
      expect(taskProgressState(task({ state: "ready_for_review" }), null, [approval], "person", review)).toMatchObject({ label: "Needs you", needsYou: true });
    }
    expect(taskProgressState(task({ state: "ready_for_review", review_state: "outdated" }), null, [], "person", { autonomy: "autonomous", personCriteria: false, ciState: "pending" }))
      .toMatchObject({ label: "Review outdated", needsYou: false });
  });

  it("makes current-version review requirements visible without claiming an old approval is current", () => {
    expect(taskProgressState(task({ state: "ready_for_review", review_state: "outdated" }), null, [], "person")).toMatchObject({ label: "Review outdated", tone: "attention" });
    expect(taskProgressState(task({ state: "working", review_state: "approved", brief_stale: true }), null, [], "person")).toMatchObject({ label: "Review outdated" });
  });

  it("ignores expired, decided and foreign-task approvals while respecting pending questions", () => {
    const approval = (patch: Partial<ApprovalRow> = {}): ApprovalRow => ({ id: "approval", task_id: "task", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString(), ...patch } as ApprovalRow);
    expect(taskProgressState(task(), null, [approval()], "person")).toMatchObject({ label: "Needs you", needsYou: true });
    expect(taskProgressState(task(), null, [approval()], "other")).toMatchObject({ label: "Needs a decision", needsYou: false });
    const irrelevant = [approval({ expires_at: new Date(Date.now() - 1).toISOString() }), approval({ status: "decided" }), approval({ task_id: "foreign" })];
    expect(taskProgressState(task(), null, irrelevant, "person")).toMatchObject({ label: "Working", needsYou: false });
  });

  it("separates human input, agent input and a stale run", () => {
    expect(taskProgressState(task({ state: "input_required", waiting_on: "human" }), null, [], "person")).toMatchObject({ label: "Needs you", needsYou: true });
    expect(taskProgressState(task({ state: "input_required", waiting_on: "human", brief_stale: true, review_state: "outdated" }), null, [], "person")).toMatchObject({ label: "Needs you", needsYou: true });
    expect(taskProgressState(task({ state: "input_required", waiting_on: "lead" }), null, [], "person")).toMatchObject({ label: "Waiting on Lead", needsYou: false });
    expect(taskProgressState(task(), { stale_at: "2026-11-04T10:00:00Z" } as RunRow, [], "person")).toMatchObject({ label: "No recent signal", needsYou: false });
  });
});

describe("per-person read markers", () => {
  it("isolates each workspace, person and database even with punctuation in identifiers", () => {
    const keys = [progressReadKey("w", "u", "db"), progressReadKey("w2", "u", "db"), progressReadKey("w", "u2", "db"), progressReadKey("w", "u", "db2"), progressReadKey("w:x", "u", "db"), progressReadKey("w", "x:u", "db")];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not call all pre-existing work new on a first visit", () => {
    const current = task({ last_activity_at: "2026-11-04T11:00:00Z", updated_at: "2026-11-04T11:30:00Z" });
    expect(updatedSinceRead(current, {})).toBe(false);
    expect(updatedSinceRead(current, { task: "2026-11-04T11:00:00Z" })).toBe(false);
    expect(updatedSinceRead(current, { task: "2026-11-04T10:00:00Z" })).toBe(true);
    expect(updatedSinceRead({ ...current, last_activity_at: null }, { task: "2026-11-04T11:00:00Z" })).toBe(true);
  });

  it("tolerates malformed storage and bounds validated markers", () => {
    for (const input of [null, "not-json", "[]", "null", "12"]) expect(parseProgressReadMarkers(input)).toEqual({});
    expect(parseProgressReadMarkers(JSON.stringify({ "": "2026-11-04", good: "2026-11-04T11:00:00Z", bad: "not-a-date", number: 4 }))).toEqual({ good: "2026-11-04T11:00:00Z" });
    const many = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`task-${index}`, "2026-11-04T11:00:00Z"]));
    expect(Object.keys(parseProgressReadMarkers(JSON.stringify(many)))).toHaveLength(500);
  });
});

describe("Trama's selected task context", () => {
  it("chooses the same active task as the detail even when an older closed task was loaded first", () => {
    const old = task({ id: "old", state: "done", acceptance: "accepted" }), current = task({ id: "current" });
    expect(progressTramaTask("database", "?progressRow=page", { old, current }, "workspace")?.id).toBe("current");
    expect(progressTramaTask("database", "?progressRow=page", { old, newer: { ...old, id: "newer", updated_at: "2099-01-01T00:00:00Z" } }, "workspace")?.id).toBe("newer");
  });

  it("rejects foreign workspaces, other databases, non-task requests and contexts with a peek or table open", () => {
    const rows = { otherWorkspace: task({ workspace_id: "foreign" }), otherDatabase: task({ db_page_id: "other" }), lesson: task({ request_kind: "lesson" }) };
    expect(progressTramaTask("database", "?progressRow=page", rows, "workspace")).toBeNull();
    for (const query of ["", "?progressRow=missing", "?progressRow=page&taskLayout=table", "?progressRow=page&peek=other"]) expect(progressTramaTask("database", query, { task: task() }, "workspace")).toBeNull();
    expect(progressTramaTask(undefined, "?progressRow=page", { task: task() }, "workspace")).toBeNull();
  });
});
