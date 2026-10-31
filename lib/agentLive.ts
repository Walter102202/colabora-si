import { useAuthStore } from "@/lib/auth";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";

// The Realtime channel of a small per-workspace store: one channel per workspace, closed by the last release.

export interface RowChange {
  eventType: string;
  new: unknown;
  old: unknown;
}

export const byId = <T extends { id: string }>(rows: T[] | null): Record<string, T> => Object.fromEntries((rows ?? []).map((r) => [r.id, r]));

export function mergeRow<T extends { id: string }>(rows: Record<string, T>, change: RowChange): Record<string, T> {
  const next = { ...rows };
  if (change.eventType === "DELETE") delete next[(change.old as { id: string }).id];
  else next[(change.new as T).id] = change.new as T;
  return next;
}

export function liveRows(prefix: string) {
  type Subscription = { channel: RealtimeChannel; client: NonNullable<ReturnType<typeof getAgentClient>>;
    workspace: string; user: ReturnType<typeof useAuthStore.getState>["user"]; subscribers: number };
  let active: Subscription | null = null;
  const close = () => {
    const closing = active;
    active = null;
    if (closing) void closing.client.removeChannel(closing.channel);
  };
  return {
    close,
    subscribe(workspaceId: string, tables: Record<string, (change: RowChange) => void>, onOpen: () => void): () => void {
      const client = getAgentClient(), user = useAuthStore.getState().user;
      // A client without Realtime gets no live rows: these views never take a page down.
      if (!client?.realtime || !user) return () => {};
      const once = (subscription: Subscription) => {
        let released = false;
        return () => {
          if (released || active !== subscription) return;
          released = true;
          if (--subscription.subscribers === 0) close();
        };
      };
      if (active?.workspace === workspaceId && active.user === user && active.client === client) {
        active.subscribers += 1;
        return once(active);
      }
      close();
      const topic = `${prefix}-${workspaceId}`;
      // removeChannel is async; don't reuse a still-registered subscribed channel.
      client.realtime.channels = client.realtime.channels.filter((c) => c.topic !== `realtime:${topic}`);
      const subscription: Subscription = { channel: client.channel(topic), client, workspace: workspaceId, user, subscribers: 1 };
      active = subscription;
      for (const [table, onChange] of Object.entries(tables)) {
        subscription.channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `workspace_id=eq.${workspaceId}` }, (change) => {
          if (active !== subscription || useAuthStore.getState().user !== user) return;
          if (change.eventType !== "DELETE" && change.new.workspace_id !== workspaceId) return;
          onChange(change);
        });
      }
      subscription.channel.subscribe();
      onOpen();
      return once(subscription);
    },
  };
}

/** Calls an RPC as the person. `messages` gives an error code a text of its own. */
export async function learningRpc<T>(name: string, args: Record<string, unknown>, messages: Record<string, string>): Promise<T> {
  const client = getAgentClient();
  if (!client) throw new Error("No connection. Agents need you to sign in.");
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(Object.hasOwn(messages, error.message) ? messages[error.message] : agentErrorMessage(error));
  return data as T;
}
