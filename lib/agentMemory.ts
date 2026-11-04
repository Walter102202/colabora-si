import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";

export interface PersonMemory {
  id: string;
  kind: "preference" | "fact" | "commitment";
  body: string;
  source_quote: string;
  status: "active" | "superseded";
}

function client() {
  const value = getAgentClient();
  if (!value) throw new Error("Sign in to manage memory.");
  return value;
}

export async function loadMemories(workspaceId: string): Promise<{ memories: PersonMemory[]; enabled: boolean }> {
  const db = client();
  const [memories, settings] = await Promise.all([
    db.from("person_memories").select("id,kind,body,source_quote,status").eq("workspace_id", workspaceId).order("created_at", { ascending: false }),
    db.from("person_memory_settings").select("enabled").eq("workspace_id", workspaceId),
  ]);
  if (memories.error || settings.error) throw new Error(agentErrorMessage(memories.error ?? settings.error));
  return { memories: memories.data ?? [], enabled: settings.data?.[0]?.enabled ?? true };
}

async function mutate(name: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await client().rpc(name, args);
  if (error) throw new Error(agentErrorMessage(error));
}
export const updateMemory = (id: string, body: string) => mutate("update_person_memory", { p_id: id, p_body: body });
export const forgetMemory = (id: string) => mutate("forget_person_memory", { p_id: id });
export const forgetAll = (workspaceId: string) => mutate("forget_all_person_memories", { p_workspace_id: workspaceId });
export const setMemoryEnabled = (workspaceId: string, enabled: boolean) => mutate("set_person_memory_enabled", { p_workspace_id: workspaceId, p_enabled: enabled });
