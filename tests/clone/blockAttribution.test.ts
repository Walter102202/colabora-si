// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorSurface } from "@/components/BlockEditor";
import type { Block } from "@/lib/types";
import { b } from "./fixtures";

const hint = "Write the plan here. The Lead reads it when it starts.";
const attr = { by: "agent" as const, id: "agent", at: 0 };
let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = (blocks: Block[], emptyHint?: string) => act(() => root.render(createElement(MemoryRouter, {}, createElement(EditorSurface, { pageId: "owner", blocks, onChange: vi.fn(), emptyHint }))));
const line = (id: string) => host.querySelector<HTMLElement>(`[data-block-id="${id}"] [contenteditable="true"]`)!;

it("marks a block an agent edited once, with the agent's name in reach", () => {
  const block = b("paragraph", { html: "Written by an agent", attr });
  mount([block]);
  const item = host.querySelector<HTMLElement>(`[data-block-id="${block.id}"]`)!;
  expect(item.querySelectorAll(".attribution-margin")).toHaveLength(1);
  expect(item.querySelector(".agent-dot")).toBeNull();
  expect(item.querySelector(".attribution-name")?.textContent).toBe("Edited by Agent");
});

it("leaves a block a person edited unmarked", () => {
  const block = b("paragraph", { html: "Written by a person" });
  mount([block]);
  expect(host.querySelector(".attribution-margin, .attribution-name")).toBeNull();
});

it("shows the empty hint while the page holds one empty line", () => {
  const block = b("paragraph", { html: "" });
  mount([block], hint);
  expect(line(block.id).dataset.placeholder).toBe(hint);
  expect(line(block.id).classList.contains("always-ph")).toBe(true);
});

it("keeps the normal prompt once the page holds more than one block", () => {
  const first = b("paragraph", { html: "" }), second = b("paragraph", { html: "The plan" });
  mount([first, second], hint);
  expect(line(first.id).dataset.placeholder).toBe("Type '/' for commands");
  expect(line(first.id).classList.contains("always-ph")).toBe(false);
});

it("does not put the hint on a block that is not plain text", () => {
  const heading = b("heading1", { html: "" });
  mount([heading], hint);
  expect(line(heading.id).dataset.placeholder).toBe("Heading 1");
});
