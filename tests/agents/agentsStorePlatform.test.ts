import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, rpc } = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn() })); // vi.mock is hoisted above the imports: plain consts would not exist yet
vi.mock("@/lib/agentClient", () => ({
  getAgentClient: () => ({ functions: { invoke }, rpc, auth: { getSession: async () => ({ data: { session: null } }) } }),
  agentErrorMessage: (e: unknown) => String(e),
}));
import { useAgentsStore } from "@/lib/agentsStore";

describe("enablePlatformAgent", () => {
  beforeEach(() => {
    invoke.mockReset(); rpc.mockReset();
    useAgentsStore.setState({ workspaceId: "ws-1", status: "ready" });
    useAgentsStore.setState({ load: async () => {} });
  });
  it("calls agent-admin with enable_platform_agent and issues the token as the person", async () => {
    invoke.mockResolvedValue({ data: { agent_id: "ag-1", auth_user_id: "u-1", created: true }, error: null });
    rpc.mockResolvedValue({ data: { token: "agt_x" }, error: null });
    const res = await useAgentsStore.getState().enablePlatformAgent();
    expect(invoke).toHaveBeenCalledWith("agent-admin", { body: { action: "enable_platform_agent", workspace_id: "ws-1" } });
    expect(rpc).toHaveBeenCalledWith("issue_agent_token", { p_agent_id: "ag-1", p_name: "default" });
    expect(res).toEqual({ agentId: "ag-1", token: "agt_x" });
  });
});
