import { describe, expect, it } from "vitest";
import { notificationHref, type NotificationRow } from "@/lib/agentNotifications";

const n = (over: Partial<NotificationRow>): NotificationRow => ({
  id: "n1", workspace_id: "w1", user_id: "u1", kind: "approval_requested", page_id: "p1", block_id: null, comment_id: null,
  task_id: "t1", approval_id: null, actor_id: null, actor_type: null, payload: {}, read_at: null, created_at: "2026-10-28T00:00:00Z", ...over,
});

describe("notificationHref", () => {
  it("points at the approval when the notification names one", () => {
    expect(notificationHref(n({ approval_id: "ap 1" }))).toBe("/p/p1?task=t1#approval-ap%201");
  });
  it("prefers the approval over the block", () => {
    expect(notificationHref(n({ approval_id: "ap1", block_id: "b1" }))).toBe("/p/p1?task=t1#approval-ap1");
  });
  it("keeps the block fragment otherwise", () => {
    expect(notificationHref(n({ block_id: "b1" }))).toBe("/p/p1?task=t1#b1");
    expect(notificationHref(n({ task_id: null, block_id: "b1" }))).toBe("/p/p1#b1");
    expect(notificationHref(n({ page_id: null }))).toBeNull();
  });
});
