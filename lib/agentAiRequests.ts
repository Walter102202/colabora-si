import { useEffect } from "react";
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";

export interface AiRequest {
  id: string;
  kind: "fill" | "rewrite";
  state: string;
  request: { property_id?: string; row_ids?: string[]; block_id?: string; [key: string]: unknown };
  closedAt?: string;
  runId?: string;
}
const EMPTY: AiRequest[] = [];
const CLOSED = ["done", "failed", "cancelled"];
const useRequests = create<{ pages: Record<string, AiRequest[]> }>(() => ({ pages: {} }));
const subscriptions = new Map<string, { refs: number; channel: RealtimeChannel; refresh: () => Promise<void> }>();

function retain(pageId: string) {
  const client = getSupabase();
  if (!client || !pageId) return () => {};
  const existing = subscriptions.get(pageId);
  if (existing) { existing.refs++; return () => release(pageId); }
  let loading = false, again = false;
  const refresh = async () => {
    if (loading) { again = true; return; }
    loading = true;
    try {
      do {
        again = false;
        const columns = "id,request_kind,state,request,closed_at,updated_at,active_run_id";
        const base = () => client.from("agent_tasks").select(columns).eq("row_page_id", pageId).in("request_kind", ["fill", "rewrite"]);
        const [open, recent] = await Promise.all([
          base().in("state", ["queued", "working", "input_required", "ready_for_review"]),
          base().in("state", CLOSED).gte("updated_at", new Date(Date.now() - 600_000).toISOString()).order("updated_at", { ascending: false }).limit(50),
        ]);
        if (open.error || recent.error) return;
        const rows = [...(open.data ?? []), ...(recent.data ?? [])];
        const closedIds = rows.filter((r) => !r.active_run_id).map((r) => r.id);
        const latest = new Map<string, string>();
        if (closedIds.length) {
          const runs = await client.from("agent_runs").select("id,task_id,started_at").in("task_id", closedIds).order("started_at", { ascending: false }).limit(1000);
          for (const run of runs.data ?? []) if (!latest.has(run.task_id)) latest.set(run.task_id, run.id);
        }
        if (subscriptions.get(pageId)?.channel !== channel) return;
        const requests = rows.map((r): AiRequest => ({ id: r.id, kind: r.request_kind, state: r.state, request: r.request ?? {},
          closedAt: r.closed_at ?? (CLOSED.includes(r.state) ? r.updated_at : undefined), runId: r.active_run_id ?? latest.get(r.id) }));
        useRequests.setState((s) => ({ pages: { ...s.pages, [pageId]: requests } }));
      } while (again);
    } finally { loading = false; }
  };
  const channel = client.channel(`ai-requests:${pageId}`).on("postgres_changes", {
    event: "*", schema: "public", table: "agent_tasks", filter: `row_page_id=eq.${pageId}`,
  }, () => { void refresh(); }).subscribe((status) => { if (status === "SUBSCRIBED") void refresh(); });
  subscriptions.set(pageId, { refs: 1, channel, refresh });
  void refresh();
  return () => release(pageId);
}
function release(pageId: string) {
  const entry = subscriptions.get(pageId);
  if (!entry || --entry.refs) return;
  subscriptions.delete(pageId);
  void getSupabase()?.removeChannel(entry.channel);
  useRequests.setState((s) => { const pages = { ...s.pages }; delete pages[pageId]; return { pages }; });
}
export function useAiRequests(pageId: string): AiRequest[] {
  const userId = useAuthStore((s) => s.user?.id);
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  useEffect(() => retain(pageId), [pageId, userId]);
  useEffect(() => {
    const agents = useAgentsStore.getState();
    if (workspaceId && (agents.workspaceId !== workspaceId || agents.status === "idle")) void agents.load(workspaceId);
  }, [workspaceId]);
  return useRequests((s) => s.pages[pageId] ?? EMPTY);
}

export function aiRequestError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    request_in_progress: "A fill is already running", ai_prompt_missing: "Write an AI instruction first.",
    not_ai_property: "This property is no longer an AI property.", delegate_not_found: "Enable Colabora or choose an available agent.",
    budget_exceeded: "This agent has reached its budget.", forbidden: "You cannot edit this page.",
    humans_only: "Only a person can request this.", page_locked: "Unlock the page first.",
    block_has_mentions: "This block has mentions or equations, which AI rewrite keeps out of reach.",
    not_text_block: "Choose a text block to rewrite.", block_too_long: "Choose a block with at most 5000 characters.",
  };
  return messages[code] ?? code;
}

// Requests must see the person's latest property settings and text, including a flush already in progress.
async function syncBeforeRequest() {
  const { flush, useSyncStatus } = await import("@/lib/sync");
  const wait = () => new Promise<void>((resolve, reject) => {
    if (useSyncStatus.getState().status !== "syncing") { resolve(); return; }
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Your edits are still syncing. Try again shortly.")); }, 15_000);
    const unsubscribe = useSyncStatus.subscribe((s) => {
      if (s.status !== "syncing") { clearTimeout(timer); unsubscribe(); resolve(); }
    });
  });
  await wait();
  await flush();
  await wait();
  const status = useSyncStatus.getState();
  if (status.status === "offline" || status.status === "error") throw new Error("Sync your edits before asking AI to work on them.");
}
export async function requestAiFill(dbPageId: string, propertyId: string, mode: "empty" | "all", rowIds?: string[]) {
  const client = getSupabase();
  if (!client) return { taskId: null, rows: 0, remaining: 0 };
  await syncBeforeRequest();
  const { data, error } = await client.rpc("request_ai_fill", { p_db_page_id: dbPageId, p_property_id: propertyId, p_mode: mode, ...(rowIds ? { p_row_ids: rowIds } : {}) });
  if (error) throw new Error(error.message);
  await subscriptions.get(dbPageId)?.refresh();
  return { taskId: data.task_id as string | null, rows: data.rows as number, remaining: data.remaining as number };
}

export async function requestAiRewrite(pageId: string, blockId: string, instruction: string, selection?: string): Promise<{ taskId: string }> {
  const client = getSupabase();
  if (!client) return { taskId: "" };
  await syncBeforeRequest();
  const { data, error } = await client.rpc("request_ai_rewrite", { p_page_id: pageId, p_block_id: blockId,
    p_instruction: instruction, ...(selection ? { p_selection: selection } : {}) });
  if (error) throw new Error(error.message);
  await subscriptions.get(pageId)?.refresh();
  return { taskId: data.task_id };
}
