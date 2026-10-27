import { create } from "zustand";
import { useEffect } from "react";
import { getSupabase } from "@/lib/supabase";
import { useStore } from "@/lib/store";
export interface DirectoryEntry { workspace_id: string; user_id: string; display_name: string; is_agent: boolean; }
export const useDirectory = create<{ entries: DirectoryEntry[]; workspaceId: string | null; workspaceName: string }>(() => ({ entries: [], workspaceId: null, workspaceName: "My Workspace" }));
export async function refreshDirectory(workspaceId: string): Promise<void> { const sb = getSupabase(); if (!sb) return; const [directory, workspace] = await Promise.all([sb.from("workspace_directory_v").select("workspace_id,user_id,display_name,is_agent").eq("workspace_id", workspaceId), sb.from("workspaces").select("name").eq("id", workspaceId).maybeSingle()]); if (useStore.getState().syncWorkspaceId !== workspaceId) return; if (!directory.error) useDirectory.setState({ entries: directory.data, workspaceId, workspaceName: workspace.data?.name ?? "My Workspace" }); }
export function useWorkspaceDirectory(): DirectoryEntry[] { const workspaceId = useStore((s) => s.syncWorkspaceId), entries = useDirectory((s) => s.entries); useEffect(() => { if (!workspaceId) { useDirectory.setState({ entries: [], workspaceId: null, workspaceName: "My Workspace" }); return; } void refreshDirectory(workspaceId); const focus = () => void refreshDirectory(workspaceId); window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus); }, [workspaceId]); return entries; }
