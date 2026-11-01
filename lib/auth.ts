import { useEffect } from "react";
import { create } from "zustand";
import type { User } from "@supabase/supabase-js";
import { HOME_URL } from "@/lib/routes";
import { getSupabase } from "@/lib/supabase";

import { cleanupPushOnSignOut, syncPushSubscription } from "@/lib/push";
const UNSYNCED_SIGN_OUT = "Some changes haven’t synced yet and will be lost if you log out now. Log out anyway?";
interface AuthState { user: User | null; loading: boolean }
export const useAuthStore = create<AuthState>(() => ({ user: null, loading: true }));
let initialized = false;
export function initAuth(): void {
  if (initialized) return;
  initialized = true;
  const invite = new URLSearchParams(location.search).get("invite"); if (invite) sessionStorage.setItem("colabora-invitation", invite);
  const supabase = getSupabase();
  if (!supabase) { useAuthStore.setState({ user: null, loading: false }); return; }
  let receivedEvent = false;
  supabase.auth.onAuthStateChange((_event, session) => {
    receivedEvent = true;
    if (session?.user) setTimeout(() => void syncPushSubscription().catch(() => {}), 0);
    useAuthStore.setState({ user: session?.user ?? null, loading: false });
  });
  void supabase.auth.getSession().then(({ data }) => {
    if (!receivedEvent) useAuthStore.setState({ user: data.session?.user ?? null, loading: false });
  }).catch(() => { if (!receivedEvent) useAuthStore.setState({ user: null, loading: false }); });
}
export function useAuth(): AuthState {
  const state = useAuthStore();
  useEffect(initAuth, []);
  return state;
}
export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  // Loaded here because lib/sync depends on the store, which depends on this module.
  const { discardLocalCopy, settleBeforeSignOut } = await import("@/lib/sync");
  if (!await settleBeforeSignOut() && !confirm(UNSYNCED_SIGN_OUT)) return;
  await cleanupPushOnSignOut();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  await discardLocalCopy();
  location.assign(HOME_URL);
}
