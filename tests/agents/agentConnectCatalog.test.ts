import { describe, expect, it } from "vitest";
import { createAgentConnectCatalog, setupMessage } from "@/lib/agentConnectCatalog";

const url = "https://example.supabase.co/functions/v1/mcp";
const catalog = createAgentConnectCatalog(url);
describe("agent connection catalog", () => {
  it("keeps the eleven choices in design order and produces public setup messages", () => {
    expect(catalog.map((entry) => entry.id)).toEqual(["claude-code", "codex", "muse-code", "cursor", "gemini-cli", "antigravity", "chatgpt", "claude", "hermes", "openclaw", "your-agent"]);
    for (const entry of catalog) {
      expect(entry.logo).toBe(`/brand/agents/${entry.id}.svg`);
      expect(entry.guide).toBe(`/connect/${entry.id}.md`);
      expect(setupMessage(entry)).toContain("Getting started");
      expect(setupMessage(entry)).not.toMatch(/<project>|agt_|\bjust\b|\bsimply\b|\binstant\b|one click|partners|official integrations|verified agents/i);
    }
  });
  it.each(["claude-code", "codex", "hermes", "openclaw"])("%s connects tasks and pages", (id) => {
    const entry = catalog.find((item) => item.id === id)!;
    expect(entry.intro).toContain("Add only these two connections");
    expect(entry.cmd).toContain(url);
    expect(entry.cmd).toContain(url.replace(/mcp$/, "workspace-mcp"));
    expect(entry.cmd).toContain("colabora-tasks");
    expect(entry.cmd).toContain("colabora-workspace");
  });
  it("encodes only the public workspace URL in the Cursor install link", () => {
    const link = new URL(catalog.find((entry) => entry.id === "cursor")!.url!);
    expect(link.protocol).toBe("cursor:");
    expect(JSON.parse(atob(link.searchParams.get("config")!))).toEqual({ url: url.replace(/mcp$/, "workspace-mcp") });
  });
  it("does not render placeholder endpoints when the backend is unconfigured", () => {
    expect(() => createAgentConnectCatalog("https://<project>.supabase.co/functions/v1/mcp")).toThrow();
  });
});
