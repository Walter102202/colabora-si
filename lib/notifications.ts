import { create } from "zustand";
import { getSupabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";
export interface WorkspaceNotification { id: string; workspace_id: string; user_id: string; kind: string; page_id: string | null; actor_id: string | null; payload: { body?: string; role?: string }; read_at: string | null; created_at: string; }
export const useNotifications = create<{ items: WorkspaceNotification[] }>(() => ({ items: [] }));
let channel: RealtimeChannel | null = null, currentUser: string | null = null;
export function stopNotifications(): void { currentUser = null; if (channel) void getSupabase()?.removeChannel(channel); channel = null; useNotifications.setState({ items: [] }); }
export function initNotifications(userId: string): void { if (currentUser === userId) return; stopNotifications(); currentUser = userId; const sb = getSupabase(); if (!sb) return;
  const refresh = async () => { const { data, error } = await sb.from("notifications").select("id,workspace_id,user_id,kind,page_id,actor_id,payload,read_at,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(100); if (!error && currentUser === userId) useNotifications.setState({ items: data }); };
  channel = sb.channel("inbox-" + userId).on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: "user_id=eq." + userId }, () => void refresh()).subscribe((status) => { if (status === "SUBSCRIBED") void refresh(); }); void refresh();
}
export async function markNotificationsRead(ids: string[]): Promise<void> { const sb = getSupabase(); if (!sb || !ids.length) return; const { error } = await sb.rpc("mark_notifications_read", { p_ids: ids }); if (error) throw error; useNotifications.setState((s) => ({ items: s.items.map((item) => ids.includes(item.id) ? { ...item, read_at: item.read_at ?? new Date().toISOString() } : item) })); }
