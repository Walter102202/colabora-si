import { describe, expect, it } from "vitest";
import { approvalPath, notificationPath, taskPath } from "@/lib/agentLinks";
import { notificationHref, type NotificationRow } from "@/lib/agentNotifications";
import { taskUrl } from "@/lib/routes";

// lib/agentLinks.ts builds on lib/routes.ts, and the Edge Functions use copies of both; these cases pin it to the inbox.
const IDS = ["row_1", "row with space", "ñandú/ü?&#", "a+b=c"];

describe("agentLinks", () => {
  it("builds the same task link as lib/routes", () => {
    for (const page of IDS) for (const task of IDS) expect(taskPath(page, task)).toBe(taskUrl(page, task));
  });
  it("points an approval at its card", () => {
    expect(approvalPath("row 1", "t1", "ap/1")).toBe(`${taskUrl("row 1", "t1")}#approval-ap%2F1`);
  });
  it("builds the same notification link as the inbox", () => {
    const base = { id: "n1", workspace_id: "w", user_id: "u", kind: "approval_requested", comment_id: null, actor_id: null,
      actor_type: null, payload: {}, read_at: null, created_at: "2026-10-30T10:00:00Z" };
    const cases = [
      { page_id: "row 1", task_id: "t1", approval_id: "ap1", block_id: null },
      { page_id: "row 1", task_id: "t1", approval_id: null, block_id: "blk 2" },
      { page_id: "row 1", task_id: null, approval_id: null, block_id: null },
      { page_id: null, task_id: "t1", approval_id: "ap1", block_id: null },
    ];
    for (const c of cases) expect(notificationPath(c)).toBe(notificationHref({ ...base, ...c } as NotificationRow));
  });
});
