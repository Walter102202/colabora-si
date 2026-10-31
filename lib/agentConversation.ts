import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";

// Non-persisted thread of the signed-in person with the workspace agent, kept live through Realtime. Only RPCs write it.

export interface PersonMessage {
  id: string;
  seq: number;
  workspace_id: string;
  direction: "in" | "out";
  channel: "surface" | "telegram" | "whatsapp";
  kind: "text" | "voice" | "system";
  body: string;
  forwarded: boolean;
  needs_reply?: boolean;
  outcome: { kind?: string; note_id?: string; page_id?: string; message_id?: string } | null;
  created_at: string;
}

export interface SendContext {
  pasted?: boolean;
  page_id?: string;
  selection?: { page_id: string; text: string };
  tz?: string;
}

export interface Draft {
  clientId: string;
  body: string;
  context: SendContext;
  clipId?: string;
  error?: string;
}

export interface AgentConversationState {
  workspaceId: string | null;
  messages: PersonMessage[]; // oldest first
  failed: Draft | null;
  subscribe: (workspaceId: string, userId: string) => () => void;
  send: (draft: Draft) => Promise<boolean>;
  undo: (noteId: string) => Promise<void>;
  openNotes: () => Promise<string | null>;
}

let channel: RealtimeChannel | null = null;
let channelUser: string | null = null;
let subscribers = 0;
let generation = 0;
let activeUser: string | null = null;

// A row can arrive twice, from the load and from Realtime. The server's seq decides the order.
export function mergeMessages(current: PersonMessage[], incoming: PersonMessage[]): PersonMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const COLUMNS = "id,seq,workspace_id,direction,channel,kind,body,forwarded,needs_reply,outcome,created_at";

export const useAgentConversation = create<AgentConversationState>()((set, get) => ({
  workspaceId: null,
  messages: [],
  failed: null,

  subscribe(workspaceId, userId) {
    const client = getAgentClient();
    if (!client) return () => {};
    if (get().workspaceId !== workspaceId || activeUser !== userId) {
      generation += 1;
      if (channel) void client.removeChannel(channel);
      channel = null;
      channelUser = null;
      activeUser = userId;
      subscribers = 0;
      set({ workspaceId, messages: [], failed: null });
    }
    const version = generation;
    const current = () => version === generation && activeUser === userId && get().workspaceId === workspaceId;
    subscribers += 1;
    void client.from("agent_messages").select(COLUMNS).eq("workspace_id", workspaceId).order("seq", { ascending: false }).limit(50).then(({ data }) => {
      if (current() && data) set({ messages: mergeMessages(get().messages, data as unknown as PersonMessage[]) });
    });
    if (channelUser !== userId && client.realtime) {
      if (channel) void client.removeChannel(channel);
      channelUser = userId;
      const topic = `agent-messages-${userId}`;
      client.realtime.channels = client.realtime.channels.filter((c) => c.topic !== `realtime:${topic}`);
      channel = client.channel(topic).on("postgres_changes", { event: "*", schema: "public", table: "agent_messages", filter: `user_id=eq.${userId}` }, (payload) => {
        const row = payload.new as PersonMessage;
        if (current() && row?.id && row.workspace_id === workspaceId) set({ messages: mergeMessages(get().messages, [row]) });
      });
      channel.subscribe();
    }
    let released = false;
    return () => {
      if (released || !current()) return;
      released = true;
      subscribers -= 1;
      if (subscribers === 0) {
        generation += 1;
        if (channel) void client.removeChannel(channel);
        channel = null;
        channelUser = null;
        activeUser = null;
        set({ workspaceId: null, messages: [], failed: null });
      }
    };
  },

  // The retry key is the draft's: a send that failed halfway cannot land twice.
  async send(draft) {
    const client = getAgentClient();
    const workspaceId = get().workspaceId;
    if (!client || !workspaceId) return false;
    const version = generation;
    const { error } = await client.rpc("post_agent_message", {
      p_workspace_id: workspaceId, p_body: draft.body, p_client_id: draft.clientId, p_context: draft.context, p_voice_clip_id: draft.clipId ?? null,
    });
    if (version !== generation) return false;
    if (error) {
      set({ failed: { ...draft, error: agentErrorMessage(error) } });
      return false;
    }
    set({ failed: null });
    return true;
  },

  async undo(noteId) {
    await getAgentClient()?.rpc("undo_note", { p_note_id: noteId });
  },

  async openNotes() {
    const client = getAgentClient();
    const workspaceId = get().workspaceId;
    if (!client || !workspaceId) return null;
    const { data } = await client.rpc("my_notes_page", { p_workspace_id: workspaceId, p_lang: navigator.language.startsWith("en") ? "en" : "es" });
    return (data as { page_id?: string } | null)?.page_id ?? null;
  },
}));
