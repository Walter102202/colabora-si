import { useEffect } from "react";
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";

export interface PresenceUser { userId: string; email: string; name?: string; color: string; activeBlockId: string | null; lastActive: number; away: boolean }
export const usePresence = create<{ others: PresenceUser[]; byBlock: Record<string, PresenceUser[]> }>(() => ({ others: [], byBlock: {} }));
export const useSharedPresenceScope = create<{ byPage: Record<string, string> }>(() => ({ byPage: {} }));
const COLORS = ["#e0574b", "#e08b30", "#c9a227", "#3fa66a", "#2fa3ab", "#3b82d6", "#8b5cf6", "#d1519c"];
export function presenceColor(userId: string): string { let h = 0; for (const c of userId) h = (h * 31 + c.charCodeAt(0)) | 0; return COLORS[Math.abs(h) % COLORS.length]; }
export const presenceName = (email: string): string => email.split("@")[0] || "Someone";
let self: PresenceUser | null = null, pageId: string | null = null, workspaceId: string | null = null, session = 0, subscribed = false, channel: RealtimeChannel | null = null;
let trackTimer: ReturnType<typeof setTimeout> | null = null, awayTimer: ReturnType<typeof setTimeout> | null = null, rejoinTimer: ReturnType<typeof setTimeout> | null = null;
let lastTrack = 0, rejoinAttempts = 0;
function readState(): void {
  if (!channel || !self) return;
  const found = new Map<string, PresenceUser>();
  for (const entries of Object.values(channel.presenceState<PresenceUser>())) for (const entry of entries) {
    if (!entry.userId || entry.userId === self.userId || (found.get(entry.userId)?.lastActive ?? -1) >= entry.lastActive) continue;
    found.set(entry.userId, { userId: entry.userId, email: entry.email ?? "", name: entry.name, color: entry.color || presenceColor(entry.userId), activeBlockId: entry.away ? null : entry.activeBlockId, lastActive: entry.lastActive, away: !!entry.away });
  }
  const others = [...found.values()].sort((a, b) => a.userId.localeCompare(b.userId)), previous = usePresence.getState();
  if (JSON.stringify(others) === JSON.stringify(previous.others)) return;
  const byBlock: Record<string, PresenceUser[]> = {};
  for (const user of others) if (!user.away && user.activeBlockId) (byBlock[user.activeBlockId] ??= []).push(user);
  for (const [id, users] of Object.entries(byBlock)) {
    const prior = previous.byBlock[id];
    if (prior?.length === users.length && prior.every((u, i) => u.userId === users[i].userId && u.color === users[i].color)) byBlock[id] = prior;
  }
  usePresence.setState({ others, byBlock });
}
function scheduleTrack(immediate = false): void {
  if (!subscribed || !channel || !self) return;
  if (trackTimer) clearTimeout(trackTimer);
  const token = session;
  const send = () => {
    trackTimer = null; if (token !== session || !channel || !self || !subscribed) return;
    lastTrack = Date.now(); void channel.track({ ...self, blockId: self.away ? null : self.activeBlockId, activeBlockId: self.away ? null : self.activeBlockId });
  };
  if (immediate || Date.now() - lastTrack >= 300) send(); else trackTimer = setTimeout(send, 300 - (Date.now() - lastTrack));
}
function rejoin(): void {
  if (rejoinTimer || !self) return;
  const token = session;
  rejoinTimer = setTimeout(() => { rejoinTimer = null; if (token !== session) return; const old = channel; channel = null; if (old) void getSupabase()?.removeChannel(old); openChannel(token); }, Math.min(1000 * 2 ** rejoinAttempts++, 30000));
}
function openChannel(token: number): void {
  const sb = getSupabase(); if (!sb || !self || !pageId || !workspaceId) return;
  const next = sb.channel(`presence:${workspaceId}:${pageId}`, { config: { presence: { key: self.userId } } }); channel = next;
  const changed = () => { if (token === session && channel === next) readState(); };
  next.on("presence", { event: "sync" }, changed).on("presence", { event: "join" }, changed).on("presence", { event: "leave" }, changed);
  next.subscribe((status) => {
    if (token !== session || channel !== next) return;
    if (status === "SUBSCRIBED") { subscribed = true; rejoinAttempts = 0; scheduleTrack(true); readState(); }
    else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) { subscribed = false; usePresence.setState({ others: [], byBlock: {} }); rejoin(); }
  });
}
function visibility(): void {
  if (awayTimer) clearTimeout(awayTimer);
  if (!self) return;
  if (document.visibilityState === "hidden") awayTimer = setTimeout(() => { if (self) { self = { ...self, away: true }; scheduleTrack(true); } }, 60000);
  else { self = { ...self, lastActive: Date.now(), away: false }; scheduleTrack(true); }
}
function online(): void { if (!subscribed) { rejoinAttempts = 0; rejoin(); } }
export function leavePresence(): void {
  session++; subscribed = false;
  if (trackTimer) clearTimeout(trackTimer); if (awayTimer) clearTimeout(awayTimer); if (rejoinTimer) clearTimeout(rejoinTimer);
  trackTimer = awayTimer = rejoinTimer = null;
  document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", online);
  const old = channel; channel = null; if (old) { void old.untrack(); void getSupabase()?.removeChannel(old); }
  self = null; pageId = workspaceId = null; lastTrack = rejoinAttempts = 0; usePresence.setState({ others: [], byBlock: {} });
}
export function joinPresence(nextPageId: string, nextWorkspaceId: string, userId: string, email: string, name?: string): void {
  if (pageId === nextPageId && workspaceId === nextWorkspaceId && self?.userId === userId) return;
  leavePresence(); if (!getSupabase()) return;
  pageId = nextPageId; workspaceId = nextWorkspaceId; self = { userId, email, name, color: presenceColor(userId), activeBlockId: null, lastActive: Date.now(), away: document.visibilityState === "hidden" };
  document.addEventListener("visibilitychange", visibility); window.addEventListener("online", online); openChannel(session);
}
export function setLocalActiveBlock(targetPageId: string, blockId: string | null): void {
  if (targetPageId !== pageId || !self) return;
  const changed = self.activeBlockId !== blockId || self.away;
  self = { ...self, lastActive: Date.now(), activeBlockId: blockId, away: false };
  if (changed) scheduleTrack();
}
export function usePresenceSession(pageId: string | null, workspaceId: string | null, userId: string | null, email: string, name?: string): void {
  useEffect(() => {
    if (pageId && workspaceId && userId) joinPresence(pageId, workspaceId, userId, email, name); else leavePresence();
    return leavePresence;
  }, [pageId, workspaceId, userId, email, name]);
}
