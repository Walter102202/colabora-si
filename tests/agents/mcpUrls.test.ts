import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpUrls } from "@/lib/agentsStore";

// The URLs the app shows in connection snippets and uses for the token exchange.
describe("mcpUrls", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the explicit MCP URL and derives the token endpoint from it", () => {
    vi.stubEnv("VITE_MCP_URL", "https://mcp.example.com/functions/v1/mcp");
    vi.stubEnv("VITE_SUPABASE_URL", "https://abc.supabase.co");
    expect(mcpUrls()).toEqual({
      mcpUrl: "https://mcp.example.com/functions/v1/mcp",
      tokenUrl: "https://mcp.example.com/functions/v1/agent-token",
    });
  });

  it("derives both endpoints from the Supabase URL when no MCP URL is set", () => {
    vi.stubEnv("VITE_MCP_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "https://abc.supabase.co");
    expect(mcpUrls()).toEqual({
      mcpUrl: "https://abc.supabase.co/functions/v1/mcp",
      tokenUrl: "https://abc.supabase.co/functions/v1/agent-token",
    });
  });

  it("falls back to a placeholder without any configuration", () => {
    vi.stubEnv("VITE_MCP_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    expect(mcpUrls()).toEqual({
      mcpUrl: "https://<project>.supabase.co/functions/v1/mcp",
      tokenUrl: "https://<project>.supabase.co/functions/v1/agent-token",
    });
  });

  it("keeps a path suffix out of the token endpoint", () => {
    vi.stubEnv("VITE_MCP_URL", "https://abc.supabase.co/functions/v1/mcp/v2");
    expect(mcpUrls().tokenUrl).toBe("https://abc.supabase.co/functions/v1/agent-token");
  });
});
