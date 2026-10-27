import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";

// Non-persisted inbox: rows of `notifications` for the signed-in person, kept
// live through the Realtime channel `inbox-<user>`. Only RPCs create rows.

export type NotificationKind =
  | "mention"
  | "comment_reply"
  | "share"
  | "invite"
  | "input_required"
  | "ready_for_review"
  | "task_failed"
  | "approval_requested"
  | "approval_expired"
  | "escalation";

export interface NotificationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: NotificationKind;
  page_id: string | null;
  block_id: string | null;
  comment_id: string | null;
  task_id: string | null;
  approval_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface AgentNotificationsState {
  userId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  notifications: NotificationRow[]; // newest first
  load: () => Promise<void>;
  subscribe: (userId: string) => () => void;
  markRead: (ids: string[]) => Promise<void>;
}

let channel: RealtimeChannel | null = null;
let channelUser: string | null = null;
let subscribers = 0;

// supabase-js returns the registered channel for a topic that still exists; after an unawaited
// removeChannel that instance is already subscribed and `.on` would throw. Drop it from the registry first.
function dropStaleChannel(client: ReturnType<typeof getAgentClient>, topic: string): void {
  if (!client) return;
  const full = `realtime:${topic}`;
  if (client.realtime.channels.some((c) => c.topic === full)) {
    client.realtime.channels = client.realtime.channels.filter((c) => c.topic !== full);
  }
}

export const useAgentNotifications = create<AgentNotificationsState>()((set, get) => ({
  userId: null,
  status: "idle",
  error: null,
  notifications: [],

  async load() {
    const client = getAgentClient();
    if (!client) return;
    set({ status: "loading", error: null });
    const { data, error } = await client.from("notifications").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) {
      set({ status: "error", error: agentErrorMessage(error) });
      return;
    }
    set({ status: "ready", notifications: (data ?? []) as NotificationRow[] });
  },

  // Reference counted like agentTasks.subscribe: one channel per user, closed by the last release.
  subscribe(userId) {
    const client = getAgentClient();
    if (!client) return () => {};
    if (channel && channelUser === userId) {
      subscribers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers -= 1;
        if (subscribers <= 0 && channel) {
          void client.removeChannel(channel);
          channel = null;
          channelUser = null;
        }
      };
    }
    if (channel) {
      void client.removeChannel(channel);
      channel = null;
    }
    subscribers = 1;
    channelUser = userId;
    set({ userId });
    dropStaleChannel(client, `agent-inbox-${userId}`);
    const ch = client
      .channel(`agent-inbox-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (payload) => {
        const list = get().notifications;
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          set({ notifications: list.filter((n) => n.id !== id) });
          return;
        }
        const row = payload.new as NotificationRow;
        const rest = list.filter((n) => n.id !== row.id);
        set({ notifications: [row, ...rest].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
      })
      .subscribe();
    channel = ch;
    void get().load();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers -= 1;
      if (channel !== ch) return;
      if (subscribers <= 0) {
        channel = null;
        channelUser = null;
        void client.removeChannel(ch);
      }
    };
  },

  async markRead(ids) {
    const client = getAgentClient();
    if (!client || ids.length === 0) return;
    const now = new Date().toISOString();
    set({ notifications: get().notifications.map((n) => (ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)) });
    const { error } = await client.rpc("mark_notifications_read", { p_ids: ids });
    if (error) {
      // Fall back to a direct update (own rows only, by policy).
      await client.from("notifications").update({ read_at: now }).in("id", ids).is("read_at", null);
    }
  },
}));

const KIND_TEXT: Record<NotificationKind, string> = {
  mention: "mentioned you",
  comment_reply: "replied to your comment",
  share: "shared a page with you",
  invite: "invited you to a workspace",
  input_required: "needs your decision",
  ready_for_review: "is ready for your review",
  task_failed: "failed",
  approval_requested: "asks for your approval",
  approval_expired: "approval expired",
  escalation: "escalated to you",
};

export function notificationText(n: NotificationRow): string {
  const title = typeof n.payload.title === "string" && n.payload.title ? n.payload.title : null;
  const actor = typeof n.payload.actor_name === "string" && n.payload.actor_name ? n.payload.actor_name : null;
  const subject = title ?? actor ?? (n.task_id ? "A task" : "Someone");
  return `${subject} ${KIND_TEXT[n.kind] ?? n.kind}`;
}

export function notificationHref(n: NotificationRow): string | null {
  if (!n.page_id) return null;
  const q = n.task_id ? `?task=${encodeURIComponent(n.task_id)}` : "";
  const hash = n.block_id ? `#${encodeURIComponent(n.block_id)}` : "";
  return `/p/${encodeURIComponent(n.page_id)}${q}${hash}`;
}
