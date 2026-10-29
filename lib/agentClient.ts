import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";

// Supabase client of the agent layer: the workspace client itself, so the
// browser holds one auth client and one session. Without env (or on the
// server) it is null and every agent surface renders its "sign in" state.
export function getAgentClient(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  return getSupabase();
}

// Readable message for an RPC or PostgREST error (PTnnn codes carry the
// actionable name in `message`).
export function agentErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  const e = error as { message?: string; details?: string; code?: string };
  if (e.message === "forbidden") return "You are not allowed to do that.";
  if (e.message === "delegate_not_found") return "That agent is not available in this workspace.";
  if (e.message === "invalid_state") return "The task changed state. Refresh and try again.";
  if (e.message === "page_locked") return "The page is locked. Unlock it to revert.";
  if (e.message === "stop_requested") return "A stop was requested for this run. Wait for the agent to stop.";
  if (e.message === "revert_conflict") return "Some of these changes were edited after the run, so nothing was reverted. Check the list and try again.";
  if (e.message === "item_not_found") return "That change is no longer in the list.";
  if (e.message === "run_active") return "The run is still active. Stop it before reverting.";
  if (e.message === "approval_not_pending") return "This was already answered.";
  if (e.message === "humans_only") return "Only a person can do that.";
  if (e.message === "cross_workspace") return "The page and the agent belong to different workspaces.";
  if (e.message === "owner_required") return "Only a workspace owner can do that.";
  if (e.message === "misconfigured") return "The server is not configured for agent tokens yet.";
  return e.message ?? e.details ?? e.code ?? "Unknown error";
}
