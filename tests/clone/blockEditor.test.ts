// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorSurface } from "@/components/BlockEditor";
import type { Block } from "@/lib/types";
import { b, column, page } from "./fixtures";

let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const Location = () => createElement("output", { "aria-label": "Current route" }, useLocation().pathname);
const mount = (blocks: Block[], locked = false) => {
  const onChange = vi.fn();
  act(() => root.render(createElement(MemoryRouter, {}, createElement(EditorSurface, { pageId: "owner", blocks, onChange, locked, pages: { child: page({ id: "child", title: "Child" }) } }), createElement(Location))));
  return onChange;
};
const item = (id: string) => host.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const handle = (id: string) => item(id).querySelector<HTMLElement>('[draggable="true"]')!;
function drag(node: HTMLElement, type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: { effectAllowed: "", setData() {}, setDragImage() {}, types: [] } }, clientY: { value: 1 } });
  act(() => node.dispatchEvent(event));
}

it("drops a block across columns once and retains live text before unmount", () => {
  const text = b(), left = column([text]), right = column([]), group = b("columns", { columns: [left, right] });
  const change = mount([group]);
  const editable = item(text.id).querySelector<HTMLElement>('[contenteditable="true"]')!;
  act(() => { editable.focus(); editable.innerHTML = "Unsaved <b>text</b>"; });
  drag(handle(text.id), "dragstart");
  const end = host.querySelectorAll<HTMLElement>(".nested-editor .block-insert-area")[1];
  drag(end, "dragover"); drag(end, "drop"); drag(handle(text.id), "dragend");
  expect(change).toHaveBeenCalledTimes(1);
  const next = change.mock.calls[0][0] as Block[];
  expect(next[0].columns?.[0].blocks).toEqual([]);
  expect(next[0].columns?.[1].blocks[0]).toMatchObject({ id: text.id, html: "Unsaved <b>text</b>" });
});

it("drags a subpage from its name, while an ordinary click still opens it", () => {
  const first = b(), link = b("page", { pageId: "child" }), change = mount([link, first]);
  const button = item(link.id).querySelector<HTMLButtonElement>(".page-link-block")!;
  expect(button.getAttribute("draggable")).toBe("true");
  drag(button, "dragstart"); drag(item(first.id), "dragover"); drag(item(first.id), "drop"); drag(button, "dragend");
  expect((change.mock.calls[0][0] as Block[]).map((block) => block.id)).toEqual([first.id, link.id]);
  expect(host.querySelector("output")!.textContent).toBe("/");
  act(() => button.click());
  expect(host.querySelector("output")!.textContent).toBe("/p/child");
});

it("keeps a locked subpage link navigable but does not enable dragging it", () => {
  const link = b("page", { pageId: "child" }), change = mount([link], true);
  const button = item(link.id).querySelector<HTMLButtonElement>(".page-link-block")!;
  expect(button.getAttribute("draggable")).not.toBe("true");
  expect(item(link.id).querySelector(".block-gutter")).toBeNull();
  drag(button, "dragstart"); expect(change).not.toHaveBeenCalled();
  act(() => button.click()); expect(host.querySelector("output")!.textContent).toBe("/p/child");
});

it("canceling a drag never commits the last hovered target", () => {
  const first = b(), second = b(), change = mount([first, second]);
  drag(handle(first.id), "dragstart"); drag(item(second.id), "dragover"); drag(handle(first.id), "dragend");
  expect(change).not.toHaveBeenCalled();
  expect(host.querySelector(".block-drop-below")).toBeNull();
});

it("shift-selects a page link without opening it and drags the selection together", () => {
  const first = b(), link = b("page", { pageId: "child" }), last = b(), change = mount([first, link, last]);
  act(() => item(first.id).querySelector<HTMLElement>('[contenteditable="true"]')!.focus());
  const pageButton = item(link.id).querySelector<HTMLElement>(".page-link-block")!;
  act(() => { pageButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true })); pageButton.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
  expect(host.querySelectorAll(".selected-block")).toHaveLength(2);
  act(() => handle(link.id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  drag(handle(link.id), "dragstart"); drag(item(last.id), "dragover"); drag(item(last.id), "drop");
  expect((change.mock.calls[0][0] as Block[]).map((block) => block.id)).toEqual([last.id, first.id, link.id]);
});
