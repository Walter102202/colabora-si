import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { canManageConnections, connectRepository, ghWebhookCommand, listConnections, revokeConnection } from "@/lib/agentCi";
const refreshCiChecks = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/agentTasks", () => ({ useAgentTasks: { getState: () => ({ refreshCiChecks }) } }));

it("builds the manual GitHub command for signed check_run deliveries", () => {
  const command = ghWebhookCommand("acme/app", "https://api.test/functions/v1/github-webhook/id", "abc123");
  expect(command).toContain("gh api repos/acme/app/hooks");
  expect(command).toContain('-f "events[]=check_run"');
  expect(command).toContain('-f "config[secret]=abc123"');
  expect(command).toContain('-f "config[url]=https://api.test/functions/v1/github-webhook/id"');
});

it.each(["workspace", "member", "neither"])("recognizes repository owners through %s ownership", async (owner) => {
  const filters: unknown[][] = [];
  const client = { from: (table: string) => {
    const query = { select: () => query, eq: (field: string, value: string) => { filters.push([table, field, value]); return query; },
      maybeSingle: async () => ({ data: (table === "workspaces" && owner === "workspace") || (table === "workspace_members" && owner === "member") ? {} : null, error: null }) };
    return query;
  } } as unknown as SupabaseClient;
  expect(await canManageConnections(client, "w", "u")).toBe(owner !== "neither");
  expect(filters).toContainEqual(["workspaces", "owner_id", "u"]);
  expect(filters).toContainEqual(["workspace_members", "role", "owner"]);
  expect(filters).toContainEqual(["workspace_members", "user_id", "u"]);
});
it("connects through agent-admin, lists only active workspace connections and revokes by RPC", async () => {
  const result = { id: "id", repo: "acme/app", webhook_url: "https://api.test/hook", secret: "secret" };
  const invoke = vi.fn().mockResolvedValue({ data: result, error: null });
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), order: vi.fn().mockResolvedValue({ data: [{ id: "id", repo: "acme/app" }], error: null }) };
  const from = vi.fn(() => query);
  const client = { functions: { invoke }, rpc, from } as unknown as SupabaseClient;
  expect(await connectRepository(client, "w", "acme/app")).toEqual(result);
  expect(refreshCiChecks).toHaveBeenCalledWith("w");
  expect(invoke).toHaveBeenCalledWith("agent-admin", { body: { action: "ci_connect", workspace_id: "w", repo: "acme/app" } });
  expect(await listConnections(client, "w")).toHaveLength(1);
  expect(from).toHaveBeenCalledWith("ci_connections"); expect(query.eq).toHaveBeenCalledWith("workspace_id", "w");
  expect(query.is).toHaveBeenCalledWith("revoked_at", null);
  await revokeConnection(client, "id"); expect(rpc).toHaveBeenCalledWith("revoke_ci_connection", { p_id: "id" });
  expect(refreshCiChecks).toHaveBeenCalledWith();
  invoke.mockResolvedValue({ data: null, error: new Error("forbidden") });
  await expect(connectRepository(client, "w", "acme/app")).rejects.toThrow("forbidden");
  rpc.mockResolvedValue({ error: new Error("offline") });
  await expect(revokeConnection(client, "id")).rejects.toThrow("offline");
});
