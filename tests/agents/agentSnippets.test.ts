import { describe, expect, it } from "vitest";
import { HARNESS_SNIPPETS, snippetFor } from "../../lib/agentSnippets";

const MCP_URL = "https://abc.supabase.co/functions/v1/mcp";
const TOKEN_URL = "https://abc.supabase.co/functions/v1/agent-token";

describe("connection snippets", () => {
  it("the Claude Code snippet carries the Supabase URL and key the bridge needs for Realtime", () => {
    const text = snippetFor("claude-code").snippet({ mcpUrl: MCP_URL, tokenUrl: TOKEN_URL });
    expect(text).toContain(`"WORKSPACE_MCP_URL": "${MCP_URL}"`);
    expect(text).toContain(`"WORKSPACE_AGENT_TOKEN_URL": "${TOKEN_URL}"`);
    expect(text).toContain('"WORKSPACE_SUPABASE_URL": "https://abc.supabase.co"');
    expect(text).toContain('"WORKSPACE_SUPABASE_KEY": "sb_publishable_..."');
    expect(text).toContain("MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:colabora");
  });

  it("falls back to a placeholder origin when the MCP URL is not a URL", () => {
    const text = snippetFor("claude-code").snippet({ mcpUrl: "not a url", tokenUrl: "" });
    expect(text).toContain('"WORKSPACE_SUPABASE_URL": "https://<project>.supabase.co"');
  });

  it("no snippet uses the old NEXT_PUBLIC_* names", () => {
    for (const harness of HARNESS_SNIPPETS) {
      const text = harness.snippet({ mcpUrl: MCP_URL, tokenUrl: TOKEN_URL });
      expect(text, harness.id).not.toMatch(/NEXT_PUBLIC_/);
      for (const note of harness.notes) expect(note, harness.id).not.toMatch(/NEXT_PUBLIC_/);
    }
  });

  it("snippetFor falls back to the first harness for unknown ids", () => {
    expect(snippetFor("nope").id).toBe(HARNESS_SNIPPETS[0].id);
  });

  it("stdio harnesses point at the bridge, like their connect/ recipes", () => {
    for (const id of ["cursor", "gemini-cli"]) {
      const text = snippetFor(id).snippet({ mcpUrl: MCP_URL, tokenUrl: TOKEN_URL });
      expect(text, id).toContain("bridge/index.mjs");
      expect(text, id).toContain("--no-channel");
      expect(text, id).not.toMatch(/Bearer <jwt/);
    }
  });
  it("every snippet starts with a line that says where to paste it", () => {
    for (const harness of HARNESS_SNIPPETS) {
      const first = harness.snippet({ mcpUrl: MCP_URL, tokenUrl: TOKEN_URL }).split("\n")[0];
      expect(first, harness.id).toMatch(/^(# |Settings)/);
    }
  });
});
