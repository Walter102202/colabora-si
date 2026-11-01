import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createAgentConnectCatalog } from "@/lib/agentConnectCatalog";

it("ships reviewed logos and a public setup guide for every choice", () => {
  const root = resolve(__dirname, "../../public");
  const catalog = createAgentConnectCatalog("https://example.test/functions/v1/mcp");
  expect(readdirSync(resolve(root, "brand/agents")).filter((name) => name.endsWith(".svg"))).toHaveLength(10);
  for (const entry of catalog) {
    const guide = readFileSync(resolve(root, `connect/${entry.id}.md`), "utf8");
    expect(guide).toContain("Checked 2026-11-01");
    expect(guide).toContain("read the Getting started page");
    expect(guide).not.toMatch(/<project>|agt_[a-zA-Z0-9_-]+|\bjust\b|\bsimply\b|\binstant\b|one click|partners|official integrations|verified agents/i);
    if (entry.id === "your-agent") continue;
    const file = resolve(root, `brand/agents/${entry.id}.svg`);
    const svg = readFileSync(file, "utf8");
    expect(svg).toMatch(/<svg\b/);
    expect(statSync(file).size).toBeLessThan(300_000);
    expect(svg).not.toMatch(/<script\b|\bon\w+\s*=|foreignObject|(?:href|xlink:href)\s*=\s*["'](?!#)|<!ENTITY|<!DOCTYPE/i);
  }
  expect(readFileSync(resolve(root, "connect.md"), "utf8")).toContain("Using another app? Connect with a remote MCP server and browser sign-in.");
});
