// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchModal from "@/components/SearchModal";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { page } from "./fixtures";
import * as localSearch from "@/lib/localSearch";

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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
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

it("does not scan the local index online with a server, but scans when offline", async () => {
  vi.useFakeTimers(); const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const search = vi.spyOn(localSearch, "searchStoredPages").mockResolvedValue([]);
  mount("alpha"); await act(async () => { await vi.advanceTimersByTimeAsync(300); }); expect(search).not.toHaveBeenCalled();
  online.mockReturnValue(false); mount("other"); await act(async () => { await vi.advanceTimersByTimeAsync(200); }); expect(search).toHaveBeenCalledOnce();
});

it("cancels the preceding stored query and never displays its late result", async () => {
  vi.useFakeTimers(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  let finish!: (hits: Awaited<ReturnType<typeof localSearch.searchStoredPages>>) => void;
  const search = vi.spyOn(localSearch, "searchStoredPages").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue([]);
  mount("older"); await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  const isCurrent = search.mock.calls[0][3]!; expect(isCurrent()).toBe(true);
  mount("newer"); expect(isCurrent()).toBe(false);
  await act(async () => { finish([{ kind: "page", id: "old", pageId: "old", title: "Obsolete result", snippet: "", score: 3 }]); });
  expect(container.textContent).not.toContain("Obsolete result");
});
