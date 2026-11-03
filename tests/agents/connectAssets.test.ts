import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { expect, it } from "vitest";
import { createAgentConnectCatalog } from "@/lib/agentConnectCatalog";

it("ships reviewed logos and a public setup guide for every choice", () => {
  const root = resolve(__dirname, "../../public");
  const catalog = createAgentConnectCatalog("https://example.test/functions/v1/mcp");
  const shipped = readdirSync(resolve(root, "brand/agents")).filter((name) => /\.(svg|png|jpg)$/.test(name));
  expect(shipped.sort()).toEqual(catalog.filter((entry) => entry.route !== "own").map((entry) => basename(entry.logo)).sort());
  const index = readFileSync(resolve(root, "connect.md"), "utf8");
  for (const entry of catalog) {
    expect(index).toContain(`[${entry.name}](${entry.guide})`);
    const guide = readFileSync(resolve(root, `connect/${entry.id}.md`), "utf8");
    expect(guide).toMatch(/^Checked \d{4}-\d{2}-\d{2}$/m);
    expect(guide).toContain("read the Getting started page");
    expect(guide).not.toMatch(/<project>|agt_[a-zA-Z0-9_-]+|\bjust\b|\bsimply\b|\binstant\b|one click|partners|official integrations|verified agents/i);
    if (entry.id === "your-agent") continue;
    const file = resolve(root, entry.logo.slice(1));
    const bytes = readFileSync(file);
    expect(statSync(file).size).toBeLessThan(300_000);
    if (extname(file) === ".png") {
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      continue;
    }
    if (extname(file) === ".jpg") {
      expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
      continue;
    }
    const svg = bytes.toString("utf8");
    expect(svg).toMatch(/<svg\b/);
    expect(svg).not.toMatch(/<script\b|\bon\w+\s*=|foreignObject|(?:href|xlink:href)\s*=\s*["'](?!#)|<!ENTITY|<!DOCTYPE/i);
  }
  expect(index).toContain("Using another app? Connect with a remote MCP server and browser sign-in.");
});
