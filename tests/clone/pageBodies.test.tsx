// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/lib/store";
import { usePageBodies } from "@/lib/usePageBodies";
import { databaseDeps, ensurePageBodies } from "@/lib/pageBodies";
import { applyingExternal } from "@/lib/externalApply";
import { isShell, shellOf } from "@/lib/pageShell";
import { fullWrite, persistFull, flushLocalWrites, startWriter, stopLocalPersistence } from "@/lib/localPersistence";
import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { useSyncStatus } from "@/lib/sync";
import { useAuthStore } from "@/lib/auth";
import { savePageRecovery } from "@/lib/syncConflicts";
import { seedWorkspace } from "@/lib/seed";
import PageView from "@/components/PageView";
import DatabaseView from "@/components/database/DatabaseView";
import PageHistoryModal from "@/components/PageHistoryModal";
import type { Page } from "@/lib/types";
import type { User } from "@supabase/supabase-js";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, column, db, page, prop, row } from "./fixtures";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  useAuthStore.setState({ user: null }); useSyncStatus.setState({ status: "idle" });
});
afterEach(() => { act(() => root.unmount()); host.remove(); stopLocalPersistence(); vi.restoreAllMocks(); });
async function setup(pages: Page[], missing: string[] = []) {
  const fake = installFakeIndexedDb();
  applyingExternal(() => useStore.setState({ pages: Object.fromEntries(pages.map((p) => [p.id, shellOf(p)])), rootOrder: pages.filter((p) => !p.parentId).map((p) => p.id), syncUserId: null, syncWorkspaceId: null }));
  const connection = await openLocalDb(); await claimWorkspace(connection, pages.filter((p) => !missing.includes(p.id)).map((p) => fullWrite(p)), [], null);
  startWriter(connection, (await readWorkspace(connection)).epoch); return fake;
}
function mount(node: React.ReactNode) { act(() => root.render(<MemoryRouter>{node}</MemoryRouter>)); }
async function loaded(ids: string[]) { await act(async () => { await ensurePageBodies(ids); }); }

it("follows relation chains once and terminates cycles", () => {
  const pages = Object.fromEntries(["a", "b", "c"].map((id, i, ids) => [id, shellOf(page({ id, database: db([prop({ type: "relation", relationDbId: ids[(i + 1) % ids.length] })]) }))]));
  expect(databaseDeps("a", pages)).toEqual(["a", "b", "c"]);
});

it("moves through loading, unavailable, and ready when sync changes", async () => {
  const p = page({ id: "p", blocks: [b()] }); await setup([p], [p.id]);
  function State() { return <output>{usePageBodies(["p"])}</output>; }
  mount(<State />); expect(host.textContent).toBe("loading");
  await loaded([p.id]); expect(host.textContent).toBe("unavailable");
  persistFull([p]); await flushLocalWrites();
  await act(async () => { useSyncStatus.setState({ status: "synced" }); });
  expect(host.textContent).toBe("ready");
});

it("keeps title and icon visible while loading and never mounts an empty editor", async () => {
  const child = page({ id: "child", parentId: "p", title: "Linked child" });
  const p = page({ id: "p", title: "Visible title", icon: "⭐", blocks: [b("columns", { columns: [column([b("page", { pageId: child.id })])] })] });
  await setup([p, child]); mount(<PageView pageId={p.id} />);
  expect(host.textContent).toContain(p.title); expect(host.textContent).toContain("⭐");
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(host.querySelector(".block-editor")).toBeNull(); expect(host.textContent).not.toContain(child.title);
  await loaded([p.id]);
  expect(host.querySelector('[aria-label="Page title"]')?.textContent).toBe(p.title);
  expect(host.textContent).toContain(child.title);
  expect(host.querySelectorAll(".page-link-block")).toHaveLength(1);
});

it("loads a row's parent database and preserves the RowPanel contract", async () => {
  const record = row({ title: "Job title", detail: "Visible property" }, "job");
  const parent = page({ id: "jobs", database: db([prop({ id: "title", type: "text" }), prop({ id: "detail", type: "text" }), prop({ id: "status", type: "agentStatus" })], [record]) });
  const job = page({ id: "job", parentId: parent.id, title: "Job title", blocks: [b("paragraph", { html: "Job brief" })] });
  const unrelated = page({ id: "other-jobs", database: db([prop({ type: "agentStatus" })]) });
  await setup([parent, job, unrelated]);
  applyingExternal(() => useStore.setState({ syncWorkspaceId: "workspace" }));
  mount(<PageView pageId={job.id} />); await loaded([job.id, parent.id]);
  expect(isShell(useStore.getState().pages[parent.id])).toBe(false);
  expect(isShell(useStore.getState().pages[unrelated.id])).toBe(true);
  expect(host.querySelector('[aria-label="Agent task"] a')?.getAttribute("href")).toBe("/p/jobs");
  expect(host.querySelector('input[value="Visible property"]') ?? [...host.querySelectorAll("input")].find((input) => input.value === "Visible property")).toBeTruthy();
  expect(host.textContent).toContain("Job brief");
});

it("keeps recovery downloads accessible when a body is unavailable", async () => {
  const p = page({ id: "p", title: "Missing page" }); await setup([p], [p.id]);
  useAuthStore.setState({ user: { id: "person" } as User }); savePageRecovery("person", { ...p, blocks: [b("paragraph", { html: "Rescue" })] });
  mount(<PageView pageId={p.id} />); await loaded([p.id]);
  expect(host.textContent).toContain("This page isn't on this device yet.");
  expect(host.querySelector('[aria-label="Saved local copies"]')?.textContent).toContain("Download local copy");
  expect(host.textContent).toContain(p.title);
});

it("loads related databases before rendering relation and rollup cells", async () => {
  const targetRow = row({ title: "Related row", amount: 42 }, "target-row");
  const target = page({ id: "target", database: db([prop({ id: "title", type: "text" }), prop({ id: "amount", type: "number" })], [targetRow]) });
  const source = page({ id: "source", database: db([prop({ id: "title", type: "text" }), prop({ id: "rel", type: "relation", relationDbId: target.id }), prop({ id: "total", type: "rollup", relationPropId: "rel", targetPropId: "amount", rollupFn: "sum" })], [row({ title: "Source row", rel: [targetRow.pageId] }, "source-row")]) });
  await setup([source, target, page({ id: targetRow.pageId, parentId: target.id, title: "Related row" }), page({ id: "source-row", parentId: source.id, title: "Source row" })]);
  mount(<DatabaseView pageId={source.id} />); expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await loaded([source.id, target.id]);
  await act(async () => { await import("@/components/database/TableView"); });
  expect(host.textContent).toContain("Related row"); expect(host.textContent).toContain("42");
});

it("loads a row property's related database before evaluating its rollup", async () => {
  const target = page({ id: "target", database: db([prop({ id: "amount", type: "number" })], [row({ amount: 37 }, "target-row")]) });
  const parent = page({ id: "parent", database: db([prop({ id: "rel", type: "relation", relationDbId: target.id }), prop({ id: "total", type: "rollup", relationPropId: "rel", targetPropId: "amount", rollupFn: "sum" })], [row({ rel: ["target-row"] }, "entry")]) });
  const entry = page({ id: "entry", parentId: parent.id, title: "Entry" });
  await setup([parent, target, entry]); mount(<PageView pageId={entry.id} />);
  await loaded([entry.id, parent.id]);
  expect(isShell(useStore.getState().pages[target.id])).toBe(false);
  expect(host.textContent).toContain("37");
});

it("loads version history before displaying snapshots", async () => {
  const p = page({ id: "p", versions: [{ id: "v", title: "Earlier title", blocks: [b("paragraph", { html: "Earlier body" })], createdAt: 100 }] });
  await setup([p]); mount(<PageHistoryModal pageId={p.id} onClose={() => {}} />); expect(host.textContent).toBe("");
  await loaded([p.id]); expect(host.textContent).toContain("Earlier title"); expect(host.textContent).toContain("Earlier body");
});

it("gives every seed database row its database parent", () => {
  const { pages } = seedWorkspace();
  for (const parent of Object.values(pages)) for (const row of parent.database?.rows ?? []) expect(pages[row.pageId]?.parentId).toBe(parent.id);
});
