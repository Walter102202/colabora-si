import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AttributionMargin } from "@/components/agents/AttributionMargin";

it("distinguishes chat attribution from a direct agent edit", () => {
  const attr = { by: "agent" as const, id: "agent", at: 0, runId: "123456789" };
  expect(renderToStaticMarkup(createElement(AttributionMargin, { blockId: "b", attr: { ...attr, via: "person" } })))
    .toContain('title="Agent · run 12345678 · via chat"');
  expect(renderToStaticMarkup(createElement(AttributionMargin, { blockId: "b", attr }))).not.toContain("via chat");
  expect(renderToStaticMarkup(createElement(AttributionMargin, { blockId: "b", attr: { ...attr, by: "human" } }))).toBe("");
});
import { createElement } from "react";
