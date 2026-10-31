import { create } from "zustand";
import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";
import { byId, learningRpc, liveRows, mergeRow } from "@/lib/agentLive";

// Non-persisted store of the sources and open discrepancies of a workspace, kept live through the Realtime channel
// `agent-sources-<workspace>`. Every change goes through an RPC: the server decides.

export interface PageSourceRow {
  id: string;
  workspace_id: string;
  page_id: string;
  source_kind: "page" | "url";
  source_page_id: string | null;
  source_block_id: string | null;
  url: string | null;
  observed_at: string;
  status: "current" | "changed" | "discrepancy";
}

export interface DiscrepancyItem {
  source_id: string;
  source_says: string;
  page_says: string;
}

export interface DiscrepancyRow {
  id: string;
  workspace_id: string;
  page_id: string;
  source_ids: string[];
  summary: string;
  items: DiscrepancyItem[];
  status: "open" | "resolved";
  created_at: string;
}

export type DiscrepancyResolution = "keep" | "update";

interface SourcesState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  sources: Record<string, PageSourceRow>;
  discrepancies: Record<string, DiscrepancyRow>;
  load: (workspaceId: string) => Promise<void>;
  subscribe: (workspaceId: string) => () => void;
}

const channel = liveRows("agent-sources");

export const useAgentSources = create<SourcesState>()((set, get) => ({
  status: "idle",
  error: null,
  sources: {},
  discrepancies: {},

  async load(workspaceId) {
    const client = getAgentClient();
    if (!client) return;
    set({ status: "loading", error: null });
    const [sources, discrepancies] = await Promise.all([
      client.from("page_sources").select("*").eq("workspace_id", workspaceId).limit(1000),
      client.from("page_discrepancies").select("*").eq("workspace_id", workspaceId).eq("status", "open").limit(200),
    ]);
    const failed = sources.error ?? discrepancies.error;
    if (failed) {
      set({ status: "error", error: agentErrorMessage(failed) });
      return;
    }
    set({ status: "ready", sources: byId(sources.data as PageSourceRow[]), discrepancies: byId(discrepancies.data as DiscrepancyRow[]) });
  },

  subscribe(workspaceId) {
    return channel.subscribe(workspaceId, {
      page_sources: (payload) => set({ sources: mergeRow(get().sources, payload) }),
      page_discrepancies: (payload) => set({ discrepancies: mergeRow(get().discrepancies, payload) }),
    }, () => void get().load(workspaceId));
  },
}));

// Selectors take the record, not the store: a selector that builds an array on every call would re-render forever.

export function sourcesOfPage(sources: Record<string, PageSourceRow>, pageId: string): PageSourceRow[] {
  return Object.values(sources).filter((s) => s.page_id === pageId);
}

export function openDiscrepancies(discrepancies: Record<string, DiscrepancyRow>): DiscrepancyRow[] {
  return Object.values(discrepancies).filter((d) => d.status === "open").sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** A pasted link: a page of this app, or an outside URL. Anything else is not a source. */
export function parseSourceInput(value: string, origin: string): { page_id: string } | { url: string } | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const page = url.origin === origin ? /^\/p\/([^/?#]+)/.exec(url.pathname) : null;
  return page ? { page_id: page[1] } : { url: url.href };
}

const MESSAGES: Record<string, string> = {
  task_exists: "Finish or close the current task on this page before requesting an update. The difference is still open.",
  direct_session_required: "Open the workspace to decide this: a chat session cannot.",
  discrepancy_resolved: "Someone already settled this.",
  source_cycle: "That page already depends on this one.",
  no_platform_agent: "Enable the platform agent in Settings → Agents first.",
};
const rpc = <T>(name: string, args: Record<string, unknown>) => learningRpc<T>(name, args, MESSAGES);

export const resolveDiscrepancy = (id: string, resolution: DiscrepancyResolution, note: string) =>
  rpc("resolve_discrepancy", { p_id: id, p_resolution: resolution, p_note: note || null });

export const declareSources = (pageId: string, sources: ({ page_id: string } | { url: string })[]) =>
  rpc("declare_sources", { p_page_id: pageId, p_sources: sources });

export const removeSource = (id: string) => rpc("remove_page_source", { p_source_id: id });
