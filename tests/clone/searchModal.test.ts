// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchModal from "@/components/SearchModal";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { page } from "./fixtures";

// A backend whose search RPC never answers: the modal is in server mode (backend, workspace and session) with the request pending.
vi.mock("@/lib/supabase", async (original) => ({ ...(await original<typeof import("@/lib/supabase")>()), getSupabase: () => ({ rpc: () => new Promise(() => {}) }) as never }));

function Location() { return createElement("output", { "data-path": useLocation().pathname }); }
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  useStore.setState({ pages: { alpha: page({ id: "alpha", title: "Alpha plan" }) }, rootOrder: ["alpha"], syncWorkspaceId: "ws-1" });
  useAuthStore.setState({ user: { id: "u-1" } as never, loading: false });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const mount = (query: string) => act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(SearchModal, { onClose: () => {}, query, onQueryChange: () => {} }), createElement(Location))));

it("SR-5 server mode shows the local ranking while the server has not answered", () => {
  mount("alpha");
  const titles = Array.from(container.querySelectorAll(".search-result")).map((el) => el.textContent ?? "");
  expect(titles.some((t) => t.includes("Alpha plan"))).toBe(true);
  expect(container.textContent).not.toContain("No results found");
});
it("SR-6 'New page' opens the page it just created at /p/<id>", () => {
  mount("brand new");
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "New page");
  expect(button).toBeDefined();
  act(() => button!.click());
  const path = container.querySelector("output")!.getAttribute("data-path")!;
  expect(path).toMatch(/^\/p\//);
  expect(useStore.getState().pages[path.slice(3)]?.title).toBe("brand new");
});
