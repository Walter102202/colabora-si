// @vitest-environment happy-dom
import { createClient } from "@supabase/supabase-js";
import * as agentClient from "@/lib/agentClient";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DatabaseView from "@/components/database/DatabaseView";
import { useStore } from "@/lib/store";
import { useAgentTasks } from "@/lib/agentTasks";
import type { DbRow, Page } from "@/lib/types";
import { db, page, prop, row, view } from "./fixtures";

const seen = vi.hoisted(() => ({ progress: vi.fn() }));
vi.mock("@/components/agents/TaskProgress", () => ({
  TaskProgress: (props: { pageId: string; rows: DbRow[]; allRows: DbRow[]; active?: boolean }) => {
    seen.progress(props);
    return <section aria-label="Task progress fixture">{props.rows.map((record) => <p key={record.id}>{String(record.cells.title)}</p>)}<textarea aria-label="Unsent feedback fixture" defaultValue="" /></section>;
  },
}));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  seen.progress.mockClear();
  useAgentTasks.setState({ tasks: {}, briefs: {}, runs: {}, rowPlans: {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

function fixture() {
  const records = [row({ title: "Keep Alpha", notes: "Original evidence" }, "first"), row({ title: "Keep Beta", notes: "Review notes" }, "second"), row({ title: "Other", notes: "Hidden by filter" }, "third")];
  const source = page({ id: "jobs", title: "Agent tasks", database: db([prop({ id: "title", name: "Task" }), prop({ id: "state", name: "Status", type: "agentStatus" }), prop({ id: "notes", name: "Notes" })], records) });
  const pages = { [source.id]: source, ...Object.fromEntries(records.map((record) => [record.pageId, page({ id: record.pageId, parentId: source.id, title: String(record.cells.title) })])) };
  useStore.setState({ pages, syncUserId: null, syncWorkspaceId: null });
  return source;
}

function Route() {
  const location = useLocation(), navigate = useNavigate();
  return <><output aria-label="Current route">{location.pathname + location.search + location.hash}</output><button type="button" onClick={() => void navigate(-1)}>Browser back</button></>;
}
async function mount(source: Page, path = "/p/jobs", props: Partial<Parameters<typeof DatabaseView>[0]> = {}) {
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}><DatabaseView pageId={source.id} {...props} /><Route /></MemoryRouter>); });
  await act(async () => { await import("@/components/database/TableView"); });
}
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const route = () => host.querySelector('[aria-label="Current route"]')!.textContent!;

it("adds Progress without modifying saved rows, views, properties or the page width preference", async () => {
  const source = fixture(), snapshot = structuredClone(source);
  await mount(source);
  expect(byLabel("Show task progress")?.getAttribute("aria-pressed")).toBe("true");
  expect(seen.progress).toHaveBeenCalled();
  const props = seen.progress.mock.calls.at(-1)![0];
  expect(props.rows.map((record: DbRow) => record.id)).toEqual(source.database!.rows.map((record) => record.id));
  expect(props.allRows).toHaveLength(3);
  expect(host.querySelector('.database-view[data-task-layout="progress"]')).not.toBeNull();
  expect(useStore.getState().pages[source.id]).toEqual(snapshot);
});

it("preserves the selection and other URL state when switching layouts and using browser back", async () => {
  const source = fixture();
  await mount(source, "/p/jobs?progressRow=second&marker=keep#block-1");
  await act(async () => { byLabel("Show task table")!.click(); });
  expect(route()).toBe("/p/jobs?progressRow=second&marker=keep&taskLayout=table#block-1");
  expect(byLabel("Show task table")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".database-table")).not.toBeNull();
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Browser back")!.click(); });
  expect(route()).toBe("/p/jobs?progressRow=second&marker=keep#block-1");
  expect(byLabel("Show task progress")?.getAttribute("aria-pressed")).toBe("true");
  expect(new URL(route(), "https://colabora.si").searchParams.has("task")).toBe(false);
});

it("keeps the same filtered, sorted rows in Progress and the editable table", async () => {
  const source = fixture();
  source.database!.views[0] = view({ name: "Selected jobs", filters: [{ id: "filter", propertyId: "title", operator: "contains", value: "Keep" }], sorts: [{ propertyId: "title", direction: "desc" }] });
  const savedView = structuredClone(source.database!.views[0]);
  await mount(source);
  expect(seen.progress.mock.calls.at(-1)![0].rows.map((record: DbRow) => record.cells.title)).toEqual(["Keep Beta", "Keep Alpha"]);
  await act(async () => { byLabel("Show task table")!.click(); });
  const inputs = [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Task"]')];
  expect(inputs.map((input) => input.value)).toEqual(["Keep Beta", "Keep Alpha"]);
  expect(useStore.getState().pages[source.id].database!.views[0]).toEqual(savedView);
});

it("commits an in-progress table edit when changing layouts without losing the other cells", async () => {
  const source = fixture();
  await mount(source, "/p/jobs?taskLayout=table");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Task"]')!;
  expect(input).not.toBeNull();
  input.value = "Renamed before blur";
  await act(async () => { byLabel("Show task progress")!.click(); });
  const records = useStore.getState().pages[source.id].database!.rows;
  expect(records[0].cells).toEqual({ title: "Renamed before blur", notes: "Original evidence" });
  expect(records.slice(1)).toEqual(source.database!.rows.slice(1));
  expect(seen.progress.mock.calls.at(-1)![0].rows[0].cells.title).toBe("Renamed before blur");
});

it("keeps an unsent task draft mounted when Table or Board is opened", async () => {
  const source = fixture();
  source.database!.views.push(view({ type: "board", name: "By status", groupBy: "state" }));
  await mount(source);
  const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="Unsent feedback fixture"]')!;
  draft.value = "Unsent review notes";
  await act(async () => { byLabel("Show task table")!.click(); });
  expect(draft.isConnected).toBe(true);
  expect(draft.closest("[hidden][inert]")).not.toBeNull();
  expect(seen.progress.mock.calls.at(-1)![0].active).toBe(false);
  await act(async () => { byLabel("Show task progress")!.click(); });
  expect(host.querySelector('[aria-label="Unsent feedback fixture"]')).toBe(draft);
  expect(draft.value).toBe("Unsent review notes");
  expect(draft.closest("[hidden]")).toBeNull();
  expect(seen.progress.mock.calls.at(-1)![0].active).toBe(true);
  await act(async () => { [...host.querySelectorAll(".database-tabs button")].find((button) => button.textContent?.includes("By status"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(draft.isConnected).toBe(true);
  expect(draft.closest("[hidden][inert]")).not.toBeNull();
  await act(async () => { (host.querySelector(".database-tabs button") as HTMLButtonElement).click(); });
  expect(host.querySelector('[aria-label="Unsent feedback fixture"]')).toBe(draft);
  expect(draft.value).toBe("Unsent review notes");
});

it("does not mount hidden task controls when opening directly in Table", async () => {
  const source = fixture();
  await mount(source, "/p/jobs?taskLayout=table");
  expect(seen.progress).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Unsent feedback fixture"]')).toBeNull();
});

it("selects a new job without clearing the existing rows or saved filters", async () => {
  const source = fixture();
  source.database!.views[0].filters = [{ id: "filter", propertyId: "title", operator: "contains", value: "Keep" }];
  const originalRows = structuredClone(source.database!.rows);
  await mount(source, "/p/jobs?marker=keep#block");
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "New job")!.click(); });
  const database = useStore.getState().pages[source.id].database!;
  expect(database.rows).toHaveLength(4);
  expect(database.rows.slice(0, 3)).toEqual(originalRows);
  expect(database.views[0].filters).toEqual(source.database!.views[0].filters);
  const url = new URL(route(), "https://colabora.si");
  expect(url.searchParams.get("progressRow")).toBe(database.rows[3].pageId);
  expect(url.searchParams.get("marker")).toBe("keep");
  expect(url.hash).toBe("#block");
  expect(seen.progress.mock.calls.at(-1)![0].allRows).toHaveLength(4);
});

it.each(["locked", "linked", "inline", "ordinary"])("does not mount agent task controls on a %s database", async (mode) => {
  const source = fixture();
  const props: Partial<Parameters<typeof DatabaseView>[0]> = {};
  let path = "/p/jobs?taskLayout=progress";
  if (mode === "locked") props.locked = true;
  if (mode === "inline") path = "/p/host?taskLayout=progress";
  if (mode === "linked") {
    props.linkedPageId = "host"; props.linkedBlockId = "linked";
    useStore.setState((state) => ({ pages: { ...state.pages, host: page({ id: "host" }) } }));
  }
  if (mode === "ordinary") source.database!.properties = source.database!.properties.filter((property) => property.type !== "agentStatus");
  await mount(source, path, props);
  expect(byLabel("Show task progress")).toBeNull();
  expect(seen.progress).not.toHaveBeenCalled();
  expect(host.querySelector(".database-table")).not.toBeNull();
});

it("keeps the existing board and returns to Progress when a table view is selected again", async () => {
  const source = fixture();
  source.database!.views.push(view({ type: "board", name: "By status", groupBy: "state" }));
  await mount(source);
  await act(async () => { [...host.querySelectorAll(".database-tabs button")].find((button) => button.textContent?.includes("By status"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(byLabel("Show task progress")).toBeNull();
  expect(host.querySelector('[aria-label="Task progress fixture"]')?.closest("[hidden][inert]")).not.toBeNull();
  expect(host.querySelector('[aria-label="Needs a Lead"]')).not.toBeNull();
  await act(async () => { (host.querySelector(".database-tabs button") as HTMLButtonElement).click(); });
  expect(byLabel("Show task progress")?.getAttribute("aria-pressed")).toBe("true");
});

it("groups an older completed subtask on the board and counts only the genuinely unassigned job", async () => {
  const source = fixture();
  source.database!.views = [view({ type: "board" }), view({ name: "Waiting on you" })];
  useStore.setState({ syncWorkspaceId: "workspace" });
  useAgentTasks.setState({ workspaceId: "workspace", subscribe: () => () => {} });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const lookup = vi.fn(async (request: RequestInfo | URL) => {
    const url = new URL(String(request));
    expect(url.searchParams.get("workspace_id")).toBe("eq.workspace");
    expect(url.searchParams.get("row_page_id")).toBe("in.(first,second,third)");
    await pending;
    return new Response(JSON.stringify([
      { id: "parent", row_page_id: "first", state: "done" },
      { id: "child", row_page_id: "second", state: "done", parent_task_id: "parent" },
    ]), { headers: { "Content-Type": "application/json" } });
  });
  const client = createClient("https://test.invalid", "anon", { global: { fetch: lookup } });
  vi.spyOn(agentClient, "getAgentClient").mockReturnValue(client);
  await mount(source);
  expect(byLabel("Open Keep Beta")).toBeNull();
  await act(async () => { finish(); });
  expect(host.querySelector('[aria-label="Needs a Lead"]')?.textContent).not.toContain("Keep Beta");
  expect(host.querySelector('[aria-label="1 of 1 subtasks done"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Needs a Lead"]')?.textContent).toContain("Other");
  expect(host.querySelector(".database-tabs")?.textContent).toContain("Waiting on you 1");
  expect(lookup).toHaveBeenCalledTimes(1);
});
