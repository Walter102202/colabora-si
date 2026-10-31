import { agentErrorMessage, getAgentClient } from "@/lib/agentClient";

export async function telegramLink(workspaceId: string, userId: string): Promise<boolean> {
  const client = getAgentClient();
  if (!client) return false;
  const { data, error } = await client.from("agent_channel_links").select("id").eq("workspace_id", workspaceId).eq("user_id", userId).is("revoked_at", null).limit(1);
  if (error) throw new Error(agentErrorMessage(error));
  return Boolean(data?.length);
}
export async function startTelegramLink(workspaceId: string): Promise<string> {
  const client = getAgentClient();
  if (!client) throw new Error("Sign in to connect Telegram.");
  const { data, error } = await client.rpc("start_channel_link", { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message === "channel_not_configured" ? "Telegram is not configured yet." : agentErrorMessage(error));
  return String(data.url);
}
export async function disconnectTelegram(workspaceId: string): Promise<void> {
  const { error } = await getAgentClient()!.rpc("disconnect_channel", { p_workspace_id: workspaceId });
  if (error) throw new Error(agentErrorMessage(error));
}
