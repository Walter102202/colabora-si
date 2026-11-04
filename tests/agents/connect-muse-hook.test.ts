import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseEnvFile, resolveCredentials, museStatePath } from "../../connect/muse-code/on-stop.mjs";

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
