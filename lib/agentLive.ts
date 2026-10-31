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
  let channel: RealtimeChannel | null = null;
  let workspace: string | null = null;
  let subscribers = 0;
  return {
    subscribe(workspaceId: string, tables: Record<string, (change: RowChange) => void>, onOpen: () => void): () => void {
      const client = getAgentClient();
      // A client without Realtime gets no live rows: these views are extras and never take a page down.
      if (!client?.realtime) return () => {};
      const once = () => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          subscribers -= 1;
          if (subscribers <= 0 && channel) {
            const closing = channel;
            channel = null;
            workspace = null;
            void client.removeChannel(closing);
          }
        };
      };
      if (channel && workspace === workspaceId) {
        subscribers += 1;
        return once();
      }
      if (channel) void client.removeChannel(channel);
      subscribers = 1;
      workspace = workspaceId;
      const topic = `${prefix}-${workspaceId}`;
      // supabase-js returns the registered channel for a live topic, and `.on` throws on one already subscribed.
      client.realtime.channels = client.realtime.channels.filter((c) => c.topic !== `realtime:${topic}`);
      const filter = `workspace_id=eq.${workspaceId}`;
      let next = client.channel(topic);
      for (const [table, onChange] of Object.entries(tables)) {
        next = next.on("postgres_changes", { event: "*", schema: "public", table, filter }, onChange);
      }
      channel = next.subscribe();
      onOpen();
      return once();
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
