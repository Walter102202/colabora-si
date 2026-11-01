// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorSurface } from "@/components/BlockEditor";
import PageView from "@/components/PageView";
import ReadOnlyPage from "@/components/ReadOnlyPage";
import { useStore } from "@/lib/store";
import { clearHistory, initHistory, undo } from "@/lib/history";
import { applyOps, diffPageToOps } from "@/lib/pageOps";
import type { Block } from "@/lib/types";
import { b, column, page } from "./fixtures";
import { flushLocalWrites } from "@/lib/localPersistence";
import type { PageBody } from "@/lib/pageShell";
import { startTestWriter } from "./localHelpers";

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
function drag(node: HTMLElement, type: string, clientY = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: { effectAllowed: "", setData() {}, setDragImage() {}, types: [] } }, clientY: { value: clientY } });
  act(() => node.dispatchEvent(event));
}

it.each(["above", "below"] as const)("materializes an unlinked child %s an empty block only on drop, with page ops and undo", async (position) => {
  const fake = await startTestWriter();
  const home = page({ id: "home", title: "Home", blocks: Array.from({ length: 4 }, (_, i) => b("paragraph", { id: `empty-${i}`, html: "" })) });
  const child = page({ id: "improvements", parentId: home.id, title: "Improvements colabora.si" });
  useStore.setState({ pages: { [home.id]: home, [child.id]: child }, rootOrder: [home.id] });
  initHistory(); clearHistory();
  const before = useStore.getState().pages;
  act(() => root.render(createElement(MemoryRouter, {}, createElement(PageView, { pageId: home.id }))));
  expect(useStore.getState().pages).toBe(before); // Opening must not materialize links.
  const link = host.querySelector<HTMLButtonElement>(".page-link-block")!;
  expect(link.textContent).toContain(child.title);
  expect(link.getAttribute("draggable")).toBe("true");
  expect(link.closest(".block-item")?.querySelector('.block-gutter [draggable="true"]')).not.toBeNull();
  const target = item("empty-1");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 10, height: 20 } as DOMRect);
  drag(link, "dragstart"); drag(target, "dragover", position === "above" ? 11 : 29);
  expect(useStore.getState().pages).toBe(before); // Hovering also writes nothing.
  drag(target, "drop");
  const saved = useStore.getState().pages[home.id], placed = saved.blocks.filter((block) => block.type === "page");
  expect(placed).toHaveLength(1);
  expect(placed[0].pageId).toBe(child.id);
  expect(saved.blocks.indexOf(placed[0])).toBe(position === "above" ? 1 : 2);
  expect(host.querySelectorAll(".page-link-block")).toHaveLength(1);
  expect(useStore.getState().pages[child.id]).toBe(child);
  const ops = diffPageToOps(home, saved);
  expect(ops).toEqual([expect.objectContaining({ op: "insert_block", block: expect.objectContaining({ type: "page", pageId: child.id }) })]);
  expect(applyOps(home, ops, { by: "human", id: "person", at: 1 }).page.blocks.map((block) => block.id)).toEqual(saved.blocks.map((block) => block.id));
  act(() => undo());
  expect(useStore.getState().pages[home.id].blocks).toEqual(home.blocks);
  expect(host.querySelectorAll(".page-link-block")).toHaveLength(1);
  await flushLocalWrites();
  expect((fake.dump("bodies") as PageBody[]).find((body) => body.id === "home")?.blocks).toEqual(home.blocks);
});

it("does not enable dragging an unlinked child on a locked page or a link in a read-only page", () => {
  const home = page({ id: "home", locked: true, blocks: Array.from({ length: 4 }, () => b("paragraph", { html: "" })) });
  const child = page({ id: "improvements", parentId: home.id, title: "Improvements colabora.si" });
  const pages = { [home.id]: home, [child.id]: child };
  useStore.setState({ pages });
  act(() => root.render(createElement(MemoryRouter, {}, createElement(PageView, { pageId: home.id }))));
  expect(host.querySelector(".page-link-block")!.getAttribute("draggable")).not.toBe("true");
  expect(host.querySelector('.block-gutter [draggable="true"]')).toBeNull();
  expect(useStore.getState().pages).toBe(pages);
  act(() => root.render(createElement(MemoryRouter, {}, createElement(ReadOnlyPage, { page: { ...home, locked: false, blocks: [b("page", { pageId: child.id })] }, pages, linkBase: "/shared" }))));
  expect(host.querySelector(".page-link-block")!.getAttribute("draggable")).not.toBe("true");
  expect(host.querySelector('.block-gutter [draggable="true"]')).toBeNull();
});

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
