import { describe, expect, it } from "vitest";
import { createCardHost, HostRpcError, UI_PROTOCOL_VERSION, type HostPort, type ToolResult } from "@/lib/agentCardHost";

// A fake host: records what the card posts and lets the test inject messages.
function fakePort() {
  const sent: Record<string, unknown>[] = [];
  let handler: ((message: unknown) => void) | null = null;
  const port: HostPort = {
    post: (message) => sent.push(message as Record<string, unknown>),
    listen: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  const receive = (message: unknown) => handler?.(message);
  const last = () => sent[sent.length - 1];
  const reply = (id: unknown, result: unknown) => receive({ jsonrpc: "2.0", id, result });
  return { port, sent, receive, last, reply, listening: () => handler !== null };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("card host bridge: handshake", () => {
  it("sends ui/initialize per the 2026-01-26 spec and ui/notifications/initialized after the result", async () => {
    const h = fakePort();
    const host = createCardHost(h.port, { name: "card", version: "9" });
    const connecting = host.connect();
    const init = h.last();
    expect(init.method).toBe("ui/initialize");
    expect(init.jsonrpc).toBe("2.0");
    expect(init.params).toEqual({
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: UI_PROTOCOL_VERSION,
      clientInfo: { name: "card", version: "9" },
      capabilities: {},
    });
    expect(h.sent.length).toBe(1);

    h.reply(init.id, {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "claude-desktop", version: "1.0.0" },
      hostContext: { theme: "dark", displayMode: "inline", styles: { variables: { "--color-text-primary": "#fff" } } },
    });
    const result = await connecting;
    expect(result.hostInfo?.name).toBe("claude-desktop");
    expect(host.context.theme).toBe("dark");
    expect(host.context.styles?.variables?.["--color-text-primary"]).toBe("#fff");
    expect(h.last()).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  });

  it("merges host-context-changed into the context and notifies listeners", async () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const connecting = host.connect();
    h.reply(h.last().id, { protocolVersion: "2026-01-26", hostContext: { theme: "light", locale: "en-US" } });
    await connecting;
    const seen: unknown[] = [];
    host.on("contextChanged", (ctx) => seen.push({ ...ctx }));
    h.receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } });
    expect(host.context).toEqual({ theme: "dark", locale: "en-US" });
    expect(seen).toEqual([{ theme: "dark", locale: "en-US" }]);
  });
});

describe("card host bridge: data from the host", () => {
  it("dispatches tool-input, tool-result and tool-cancelled notifications", () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const inputs: unknown[] = [];
    const results: ToolResult[] = [];
    const cancels: string[] = [];
    host.on("toolInput", (args) => inputs.push(args));
    host.on("toolResult", (r) => results.push(r));
    host.on("toolCancelled", (reason) => cancels.push(reason));
    h.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { task_id: "t1" } } });
    h.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "ok" }], structuredContent: { kind: "task" } } });
    h.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: { reason: "user" } });
    h.receive({ jsonrpc: "2.0", method: "ui/notifications/unknown-thing", params: {} });
    h.receive({ not: "jsonrpc" });
    expect(inputs).toEqual([{ task_id: "t1" }]);
    expect(results).toEqual([{ content: [{ type: "text", text: "ok" }], structuredContent: { kind: "task" } }]);
    expect(cancels).toEqual(["user"]);
    expect(h.sent).toEqual([]);
  });

  it("answers ping and ui/resource-teardown requests from the host, and -32601 otherwise", () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const reasons: string[] = [];
    host.on("teardown", (reason) => reasons.push(reason));
    h.receive({ jsonrpc: "2.0", id: "p1", method: "ping" });
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
    h.receive({ jsonrpc: "2.0", id: 7, method: "ui/resource-teardown", params: { reason: "conversation closed" } });
    expect(reasons).toEqual(["conversation closed"]);
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    h.receive({ jsonrpc: "2.0", id: 8, method: "ui/nope" });
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found: ui/nope" } });
  });
});

describe("card host bridge: requests to the host", () => {
  it("correlates tools/call by id and resolves with the CallToolResult", async () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const a = host.callTool("get_task", { task_id: "t1" });
    const b = host.callTool("send_message", { task_id: "t1", body: "go", signal: "continue" });
    const [reqA, reqB] = h.sent;
    expect(reqA).toEqual({ jsonrpc: "2.0", id: reqA.id, method: "tools/call", params: { name: "get_task", arguments: { task_id: "t1" } } });
    expect(reqB.id).not.toBe(reqA.id);
    h.reply(reqB.id, { content: [], structuredContent: { activity_id: "x" } });
    h.reply(reqA.id, { content: [{ type: "text", text: "Task" }], structuredContent: { kind: "task" } });
    expect(await a).toEqual({ content: [{ type: "text", text: "Task" }], structuredContent: { kind: "task" } });
    expect(await b).toEqual({ content: [], structuredContent: { activity_id: "x" } });
  });

  it("rejects with HostRpcError on a JSON-RPC error and ignores unknown ids", async () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const p = host.callTool("close_task", { task_id: "t1", acceptance: "accepted" });
    h.receive({ jsonrpc: "2.0", id: 999, result: {} });
    h.receive({ jsonrpc: "2.0", id: h.last().id, error: { code: -32602, message: "Invalid arguments", data: { errors: ["x"] } } });
    await expect(p).rejects.toMatchObject({ name: "HostRpcError", code: -32602, message: "Invalid arguments", data: { errors: ["x"] } });
    await expect(p).rejects.toBeInstanceOf(HostRpcError);
  });

  it("sends ui/open-link, ui/message, ui/request-display-mode and ui/update-model-context with the spec params", async () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const open = host.openLink("https://app.example/p/row1?task=t1");
    expect(h.last()).toMatchObject({ method: "ui/open-link", params: { url: "https://app.example/p/row1?task=t1" } });
    h.reply(h.last().id, {});
    await open;

    const msg = host.sendMessage("Approved the email.");
    expect(h.last()).toMatchObject({ method: "ui/message", params: { role: "user", content: { type: "text", text: "Approved the email." } } });
    h.reply(h.last().id, {});
    await msg;

    const mode = host.requestDisplayMode("fullscreen");
    expect(h.last()).toMatchObject({ method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    h.reply(h.last().id, { mode: "inline" });
    expect(await mode).toBe("inline");
    expect(host.context.displayMode).toBe("inline");

    const ctx = host.updateModelContext({ content: [{ type: "text", text: "The person approved ap1." }] });
    expect(h.last()).toMatchObject({ method: "ui/update-model-context", params: { content: [{ type: "text", text: "The person approved ap1." }] } });
    h.reply(h.last().id, {});
    await ctx;
  });

  it("size-changed and log are notifications without an id", () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    host.sizeChanged(400, 320);
    expect(h.last()).toEqual({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 400, height: 320 } });
    host.log("info", { step: "rendered" });
    expect(h.last()).toEqual({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "colabora task card", data: { step: "rendered" } } });
  });

  it("close stops listening and rejects what is still pending", async () => {
    const h = fakePort();
    const host = createCardHost(h.port);
    const p = host.callTool("get_task", { task_id: "t1" });
    host.close();
    await expect(p).rejects.toBeInstanceOf(HostRpcError);
    expect(h.listening()).toBe(false);
    await expect(host.callTool("get_task", { task_id: "t1" })).rejects.toMatchObject({ code: -32000 });
    host.sizeChanged(1, 1);
    await tick();
    expect(h.sent.length).toBe(1);
  });
});
