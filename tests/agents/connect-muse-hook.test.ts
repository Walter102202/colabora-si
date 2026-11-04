import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseEnvFile, resolveCredentials, museStatePath, runMuseStopHook } from "../../connect/muse-code/on-stop.mjs";

import { MCP_URL, TASK, fakeRemote, clock, sleep, none } from "./stopHookFake";

describe("Muse credentials", () => {
  it("parses BOM, CRLF, comments, exports and quoted values without losing equals signs", () => {
    expect(parseEnvFile('\uFEFF# comment\r\n\r\nA=plain\r\nB="double"\r\nC=\'single\'\r\nexport D=value\r\na=b=c\r\ninvalid')).toEqual({
      A: "plain", B: "double", C: "single", D: "value", a: "b=c",
    });
  });
  it.each([["--env", "C:/x/creds.env"], ["--env=C:/x/creds.env"], []])("resolves the credential file with arguments %j", (...argv) => {
    const paths: string[] = [];
    const result = resolveCredentials({ env: {}, argv, home: "/home/u", readFile: path => {
      paths.push(path);
      return "WORKSPACE_MCP_URL=https://ws.test/functions/v1/mcp\nWORKSPACE_AGENT_PAT=agt_secret\nUNRELATED=ignored";
    } });
    expect(paths).toEqual([argv.length ? "C:/x/creds.env" : join("/home/u", ".config", "muse", "colabora.env")]);
    expect(result).toEqual({ WORKSPACE_MCP_URL: "https://ws.test/functions/v1/mcp", WORKSPACE_AGENT_PAT: "agt_secret" });
  });
  it("lets only supported process variables override the file", () => {
    expect(resolveCredentials({ env: { HOOK_WAIT_MIN: "5", UNRELATED: "ignored" }, argv: [], readFile: () => "HOOK_WAIT_MIN=25" })).toEqual({ HOOK_WAIT_MIN: "5" });
  });
  it("fails open without logging the file path or error details, retaining process credentials", () => {
    const logs: string[] = [];
    const options = { argv: ["--env", "private-path"], readFile: () => { throw new Error("private-path agt_secret"); }, log: (message: string) => logs.push(message) };
    expect(resolveCredentials({ ...options, env: {} })).toEqual({});
    expect(resolveCredentials({ ...options, env: { WORKSPACE_AGENT_PAT: "agt_secret" } })).toEqual({ WORKSPACE_AGENT_PAT: "agt_secret" });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join(" ")).not.toMatch(/private-path|agt_secret/);
  });
  it("isolates and bounds session filenames, with an explicit state override", () => {
    expect(museStatePath("abc-123", "/home/u")).toBe(join("/home/u", ".config", "muse", "colabora-hook-abc-123.json"));
    expect(museStatePath("../a b", "/home/u")).toBe(join("/home/u", ".config", "muse", "colabora-hook-.._a_b.json"));
    expect(museStatePath("x".repeat(100), "/home/u")).toBe(join("/home/u", ".config", "muse", `colabora-hook-${"x".repeat(80)}.json`));
    expect(museStatePath("", "/home/u")).toBeNull();
    expect(museStatePath("", "/home/u", "custom-state.json")).toBe("custom-state.json");
  });
});

const credentials = () => `WORKSPACE_MCP_URL=${MCP_URL}\nWORKSPACE_AGENT_PAT=agt_secret\nHOOK_WAIT_MIN=25`;
const queued = { tasks: [{ task_id: TASK, state: "queued", reason: "queued" }], next_cursor: "c-1" };
const options = () => ({ env: {}, argv: [], readFile: credentials, now: clock(60_000), sleep });

describe("Muse stop hook", () => {
  it("converts a Muse payload into a queued continuation without passing transcript content", async () => {
    const { fetchImpl, calls, inits } = fakeRemote([queued]);
    const paths: string[] = [];
    const result = await runMuseStopHook({ ...options(), fetchImpl, home: "/h", stateFor: path => {
      paths.push(path); return { load: () => ({}), save: () => {} };
    }, input: {
      hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "PRIVATE_MESSAGE",
      session_id: "s-1", turn_id: "turn-1", cwd: "/workspace", transcript_path: "PRIVATE_TRANSCRIPT",
      model: "echo", permission_mode: "default", model_provider: "echo",
    } });
    expect(JSON.parse(result.output!).decision).toBe("block");
    expect(JSON.parse(result.output!).reason).toContain(`claim_task("${TASK}")`);
    expect(result.output).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_TRANSCRIPT/);
    expect(calls[0]).toEqual({ name: "wait_for_my_tasks", args: { timeout_s: 0 } });
    expect(inits[0].params.clientInfo.name).toBe("colabora-muse-stop-hook");
    expect(paths).toEqual([join("/h", ".config", "muse", "colabora-hook-s-1.json")]);
  });
  it.each(["missing", "url-only"])("does not contact the server with %s credentials", async mode => {
    let requests = 0;
    const result = await runMuseStopHook({ ...options(), input: {}, readFile: () => {
      if (mode === "missing") throw new Error("missing");
      return `WORKSPACE_MCP_URL=${MCP_URL}`;
    }, fetchImpl: async () => { requests++; throw new Error("unexpected network"); } });
    expect(result).toEqual({ exitCode: 0 });
    expect(requests).toBe(0);
  });
  it.each(["feedback", "queued"])("keeps the shared continuation rule for pending %s", async reason => {
    const { fetchImpl } = fakeRemote([{ tasks: [{ task_id: TASK, state: "queued", reason }], next_cursor: "c-1" }, none]);
    const result = await runMuseStopHook({ ...options(), input: { stop_hook_active: true }, fetchImpl });
    if (reason === "feedback") expect(result).toEqual({ exitCode: 0 });
    else expect(JSON.parse(result.output!).decision).toBe("block");
  });
  it("redacts the PAT through five failed waits and exits without a continuation", async () => {
    const remote = fakeRemote([none]);
    const logs: string[] = [];
    let failures = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.params?.name === "wait_for_my_tasks") { failures++; throw new Error("boom agt_secret"); }
      return remote.fetchImpl(input, init);
    };
    const result = await runMuseStopHook({ ...options(), now: clock(1000), input: {}, fetchImpl, log: message => logs.push(message) });
    expect(result).toEqual({ exitCode: 0 });
    expect(failures).toBe(5);
    expect(logs.join(" ")).not.toContain("agt_secret");
    expect(logs.join(" ")).toContain("[redacted]");
  });
  it("persists a notice only after delivery and retains it when acknowledgement fails", async () => {
    const notice = { task_id: TASK, state: "done", reason: "updated", notice: {
      event_id: "one", ack_cursor: "ack:one", type: "task.updated", payload: { environment_release: [] },
    } };
    const remote = fakeRemote([{ tasks: [notice], next_cursor: "scan" }]);
    let saved: { delivered?: Record<string, string> } = {};
    const result = await runMuseStopHook({ ...options(), input: { session_id: "s-1" }, stateFor: () => ({
      load: () => saved, save: value => { saved = structuredClone(value); },
    }), fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.params?.arguments?.after === "ack:one") throw new Error("ack unavailable");
      return remote.fetchImpl(input, init);
    } });
    expect(result.output).toBeDefined();
    expect(saved).toEqual({});
    await result.acknowledge!();
    expect(saved.delivered).toEqual({ one: "ack:one" });
  });
  it("does not create session state without a session id", async () => {
    const { fetchImpl } = fakeRemote([queued]);
    let states = 0;
    await runMuseStopHook({ ...options(), input: {}, fetchImpl, stateFor: () => {
      states++; return { load: () => ({}), save: () => {} };
    } });
    expect(states).toBe(0);
  });
});
