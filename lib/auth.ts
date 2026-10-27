import { useEffect } from "react";
import { create } from "zustand";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import { useHydrated } from "@/lib/useHydrated";

interface AuthState { user: User | null; loading: boolean }
export const useAuthStore = create<AuthState>(() => ({ user: null, loading: true }));
let initialized = false;
export function initAuth(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const supabase = getSupabase();
  if (!supabase) { useAuthStore.setState({ user: null, loading: false }); return; }
  let receivedEvent = false;
  supabase.auth.onAuthStateChange((_event, session) => {
    receivedEvent = true;
    useAuthStore.setState({ user: session?.user ?? null, loading: false });
  });
  void supabase.auth.getSession().then(({ data }) => {
    if (!receivedEvent) useAuthStore.setState({ user: data.session?.user ?? null, loading: false });
  }).catch(() => { if (!receivedEvent) useAuthStore.setState({ user: null, loading: false }); });
}
export function useAuth(): AuthState {
  const hydrated = useHydrated(), state = useAuthStore();
  useEffect(initAuth, []);
  return hydrated ? state : { user: null, loading: true };
}
export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
