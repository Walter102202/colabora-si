import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Supabase client of the agent layer. It uses the same public env as the
// workspace sync client and the default storage key, so it sees the person's
// session without importing the workspace auth module. Without env it is null
// and every agent surface renders its "sign in" state.

let client: SupabaseClient | null | undefined;

export function getAgentClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || typeof window === "undefined") {
    client = null;
    return client;
  }
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

// Readable message for an RPC or PostgREST error (PTnnn codes carry the
// actionable name in `message`).
export function agentErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  const e = error as { message?: string; details?: string; code?: string };
  if (e.message === "forbidden") return "You are not allowed to do that.";
  if (e.message === "humans_only") return "Only a person can do that.";
  if (e.message === "cross_workspace") return "The page and the agent belong to different workspaces.";
  if (e.message === "misconfigured") return "The server is not configured for agent tokens yet.";
  return e.message ?? e.details ?? e.code ?? "Unknown error";
}
