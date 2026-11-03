import { describe, expect, it } from "vitest";
import type { McpTool } from "../../agent/mcpClient.mjs";
import { composeMcp } from "../../agent/mcpCompose.mjs";

/** Mirrors createMcpClient: instructions become known only after initialize(). */
function fakeClient({ tools, instructions }: { tools: string[]; instructions?: string }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    instructions: undefined as string | undefined,
    initialized: 0,
    calls,
    async initialize() { client.initialized++; client.instructions = instructions; },
    async listTools(): Promise<McpTool[]> {
      return tools.map((name) => ({ name, description: `${name} of ${instructions ?? "anon"}`, inputSchema: { type: "object", properties: {} } }));
    },
    async callTool(name: string, args: Record<string, unknown>) { calls.push({ name, args }); return { isError: false, data: { ok: name }, text: name }; },
    async accessToken(fresh = false) { return `jwt-${instructions ?? "anon"}${fresh ? "-fresh" : ""}`; },
  };
  return client;
}

describe("composeMcp", () => {
  it("merges tool lists with task-endpoint precedence and routes calls by name", async () => {
    const task = fakeClient({ tools: ["read_page", "append_blocks"], instructions: "tasks" });
    const ws = fakeClient({ tools: ["read_page", "create_database"], instructions: "workspace" });
    const mcp = composeMcp(task, ws);
    await mcp.initialize();
    const listed = await mcp.listTools();
    expect(listed.map((t) => t.name)).toEqual(["append_blocks", "create_database", "read_page"]);
    expect(listed.find((t) => t.name === "read_page")?.description).toBe("read_page of tasks");
    await mcp.callTool("read_page", { page_id: "p" });
    await mcp.callTool("create_database", { title: "Launch" });
    await mcp.callTool("unknown_tool", {});
    expect(task.calls.map((c) => c.name)).toEqual(["read_page", "unknown_tool"]);
    expect(ws.calls).toEqual([{ name: "create_database", args: { title: "Launch" } }]);
    expect(mcp.instructions).toBe("tasks\n\nworkspace");
  });

  it("initializes both clients, reads instructions lazily and keeps the task client's token", async () => {
    const task = fakeClient({ tools: ["read_page"] });
    const ws = fakeClient({ tools: ["create_page"], instructions: "workspace" });
    const mcp = composeMcp(task, ws);
    expect(mcp.instructions).toBeUndefined();
    await mcp.initialize();
    expect(task.initialized).toBe(1);
    expect(ws.initialized).toBe(1);
    expect(mcp.instructions).toBe("workspace");
    const token = mcp.accessToken;
    expect(await token(true)).toBe("jwt-anon-fresh");
  });

  it("routes a call issued before any listTools", async () => {
    const task = fakeClient({ tools: ["read_page"], instructions: "tasks" });
    const ws = fakeClient({ tools: ["create_page"], instructions: "workspace" });
    const mcp = composeMcp(task, ws);
    await mcp.initialize();
    await mcp.callTool("create_page", { title: "New" });
    expect(ws.calls.map((c) => c.name)).toEqual(["create_page"]);
    expect(task.calls).toEqual([]);
  });
});
