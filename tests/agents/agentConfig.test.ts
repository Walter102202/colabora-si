import { describe, expect, it } from "vitest";
import { parseDotenv, readConfig } from "../../agent/config.mjs";

const BASE = {
  MODEL_BASE_URL: "https://models.test/v1/",
  MODEL_NAME: "model-1",
  WORKSPACE_MCP_URL: "https://ws.test/functions/v1/mcp",
  WORKSPACE_AGENT_PAT: "agt_secret",
};

describe("reference agent config", () => {
  it("reads WORKSPACE_APP_URL for deep links and strips the trailing slash", () => {
    expect(readConfig({ ...BASE, WORKSPACE_APP_URL: "https://app.test/" }).appUrl).toBe("https://app.test");
  });

  it("disables deep links without WORKSPACE_APP_URL and ignores the old NEXT_PUBLIC_APP_URL", () => {
    expect(readConfig(BASE).appUrl).toBe("");
    expect(readConfig({ ...BASE, NEXT_PUBLIC_APP_URL: "https://old.test" }).appUrl).toBe("");
  });

  it("derives the token URL from the MCP origin and applies defaults", () => {
    const config = readConfig(BASE);
    expect(config.tokenUrl).toBe("https://ws.test/functions/v1/agent-token");
    expect(config.modelBaseUrl).toBe("https://models.test/v1");
    expect(config.harness).toBe("reference-agent");
    expect(config.maxTurns).toBe(40);
  });

  it("names every missing required setting", () => {
    expect(() => readConfig({ MODEL_BASE_URL: "x" })).toThrow("missing required settings: MODEL_NAME, WORKSPACE_MCP_URL, WORKSPACE_AGENT_PAT");
  });

  it("parses dotenv text with comments, quotes and export prefixes", () => {
    const text = ["# c", "export A=1", 'B="two\\nlines"', "C='three' # x", "D=four # comment"].join("\n");
    expect(parseDotenv(text)).toEqual({ A: "1", B: "two\nlines", C: "three", D: "four" });
  });
});
