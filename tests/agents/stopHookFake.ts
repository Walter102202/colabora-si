export const MCP_URL = "https://ws.test/functions/v1/mcp";
export const ENV = { WORKSPACE_MCP_URL: MCP_URL, WORKSPACE_AGENT_PAT: "agt_secret", HOOK_WAIT_MIN: "25" };
export const TASK = "22222222-2222-2222-2222-222222222222";

export type Tasks = { tasks: Record<string, unknown>[]; next_cursor: string };
export type ToolCall = { name: string; args: Record<string, unknown> };

/** Fake remote: `waits` answers successive wait_for_my_tasks calls (the last one repeats). */
export function fakeRemote(waits: Tasks[], detail: unknown = { activities: [] }) {
  const calls: ToolCall[] = [];
  const inits: { params: { clientInfo: { name: string; version: string } } }[] = [];
  const delivered = new Set<string>();
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/agent-token")) return Response.json({ access_token: "jwt-1", expires_in: 3600, agent_id: "agent-1" });
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") { inits.push(body); return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }); }
    if (body.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
    const { name, arguments: args } = body.params;
    calls.push({ name, args });
    if (name === "wait_for_my_tasks" && String(args.after).startsWith("ack:")) {
      delivered.add(String(args.after).slice(4));
      return Response.json({jsonrpc:"2.0",id:body.id,result:{structuredContent:{changed:false,tasks:[]}}});
    }
    let structuredContent: unknown = detail;
    if (name === "wait_for_my_tasks") {
      const response = waits[Math.min(index, waits.length - 1)];
      structuredContent = { changed: response.tasks.length > 0, ...response,
        tasks: response.tasks.filter(task => !delivered.has(String((task.notice as {event_id?: string} | undefined)?.event_id))) };
      index++;
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }], structuredContent } });
  }) as typeof fetch;
  return { fetchImpl, calls, inits };
}

/** A clock that advances `stepMs` on every read. */
export function clock(stepMs: number) {
  let t = 1_000_000;
  return () => (t += stepMs);
}

export const sleep = async () => {};
export const none: Tasks = { tasks: [], next_cursor: "c-0" };
