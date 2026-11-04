// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { sanitizeBlocks, seedWorkspace } from "@/lib/seed";
import { createAgentConnectCatalog } from "@/lib/agentConnectCatalog";

it("seeds five useful roots with safe links to every connection choice", () => {
  const { pages, rootOrder } = seedWorkspace();
  const roots = rootOrder.map((id) => pages[id]);
  expect(roots.map(({ title, icon }) => [title, icon])).toEqual([
    ["Getting started", "👋"], ["Working with agents", "🤝"], ["Connect your agents", "🔌"], ["Agent Tasks", "🤖"], ["Meetings", "🎙️"],
  ]);
  expect(roots.map((page) => page.title)).not.toContain("Tasks");
  expect(roots.map((page) => page.title)).not.toContain("Quick Notes");
  for (const page of Object.values(pages)) {
    expect(page.blocks.map((block) => block.html).join(" ")).not.toMatch(/browser|local-first/i);
    expect(sanitizeBlocks(page.blocks)).toEqual(page.blocks);
  }
  const meetings = roots[4];
  expect(meetings.database).toBeUndefined();
  expect(meetings.cover).toContain("/gardener.webp");
  expect(meetings.updatedAt).toBe(meetings.createdAt);
  expect(meetings.blocks.map((block) => block.type)).toEqual(["callout", "paragraph", "paragraph", "meeting"]);
  expect(meetings.blocks[3].meeting).toMatchObject({ status: "idle", launcher: true });
  const content = document.createElement("div");
  content.innerHTML = roots[2].blocks.map((block) => block.html).join("");
  const links = [...content.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toEqual(["/connect", "/agents", ...createAgentConnectCatalog("https://example.test/functions/v1/mcp").map((entry) => `/connect/${entry.id}`)]);
});
