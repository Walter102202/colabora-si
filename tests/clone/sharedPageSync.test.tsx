// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { useAuthStore } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { foreignPageIds } from "@/lib/foreignPages";
import { applyOps, type PageOp } from "@/lib/pageOps";
import { loadPageRecoveries, pageRecoveryCopies, savePageRecovery, usePageRecoveries } from "@/lib/syncConflicts";
import SharedPageView from "@/components/SharedPageView";
import type { PageRow } from "@/lib/syncMerge";
import { b, page } from "./fixtures";

const h = vi.hoisted(() => ({ row: null as unknown as PageRow & { workspace_id: string }, push: vi.fn(),
  access: "edit" as string | null, queues: new Map<string, unknown>(), scopes: [] as string[] }));
vi.mock("@/lib/auth", async (original) => { const actual = await original<typeof import("@/lib/auth")>(); return { ...actual, useAuth: actual.useAuthStore }; });
vi.mock("@/lib/supabase", () => ({ getSupabase: () => ({ channel: () => { const c = { on: () => c, subscribe: () => c }; return c; }, removeChannel: async () => "ok" }) }));
vi.mock("@/lib/shares", () => ({ fetchMyShareLevel: async () => h.access, fetchSharedPage: async () => structuredClone(h.row), pushSharedPage: (...args: unknown[]) => h.push(...args), fetchPageBundle: async () => null, addSharedComment: async () => null }));
vi.mock("@/components/PageView", () => ({ default: function FakePage({ pageId }: { pageId: string }) { return <div>{useStore(s => s.pages[pageId]?.blocks[0]?.html)}</div>; }, PageRecoveryNotice: () => null }));
vi.mock("@/components/ReadOnlyPage", () => ({ default: () => null }));
vi.mock("@/lib/opsQueue", async (original) => {
  const actual = await original<typeof import("@/lib/opsQueue")>();
  class Queue extends actual.MemoryQueue {
    readonly ready = Promise.resolve();
    constructor(private scope: string) {
      super(); h.scopes.push(scope);
      const saved = h.queues.get(scope) as { pending: Queue["pending"]; revisions: Queue["revisions"] } | undefined;
      if (saved) { this.pending = structuredClone(saved.pending); this.revisions = structuredClone(saved.revisions); }
    }
    protected changed(): void { h.queues.set(this.scope, structuredClone({ pending: this.pending, revisions: this.revisions })); }
    async close(): Promise<void> { await this.settled(); }
  }
  return { ...actual, IndexedDbQueue: Queue };
});
let root: Root | null, container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const mount = async () => { root = createRoot(container); await act(async () => { root!.render(<SharedPageView pageId="shared" />); await settle(); }); };
const unmount = async () => { await act(async () => { root!.unmount(); root = null; await settle(); }); };
const edit = (html: string) => act(() => useStore.getState().updateBlock("shared", "b", { html }));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); foreignPageIds.clear(); localStorage.clear(); h.queues.clear(); h.scopes.length = 0;
  useAuthStore.setState({ user: { id: "editor" } as User, loading: false });
  useStore.setState({ pages: {}, rootOrder: [], syncWorkspaceId: "own", syncUserId: "editor", syncedBlocks: {}, reminders: [] });
  h.row = { id: "shared", workspace_id: "owner", revision: 1, deleted_at: null, updated_at: new Date().toISOString(), data: page({ id: "shared", revision: 1, blocks: [b("paragraph", { id: "b", rev: 1, html: "Saved" })] }) };
  h.access = "edit"; h.push.mockReset().mockRejectedValue(new Error("Offline"));
  container = document.createElement("div"); document.body.appendChild(container); root = null;
});
afterEach(async () => { if (root) await unmount(); container.remove(); vi.useRealTimers(); });
it("restores offline edits on reopen and retries them without inserting a personal page", async () => {
  await mount(); edit("Offline draft");
  await act(async () => { await vi.advanceTimersByTimeAsync(1201); });
  expect(container.textContent).toContain("Offline draft"); await unmount();
  expect(useStore.getState().pages.shared).toBeUndefined();
  expect(JSON.parse(localStorage.getItem("colabora-workspace")!).state.pages.shared).toBeUndefined();
  await mount(); expect(container.textContent).toContain("Offline draft");
  expect(h.scopes).toEqual(["editor:owner:shared:shared", "editor:owner:shared:shared"]);
  h.push.mockImplementation(async (_id: string, ops: PageOp[]) => {
    const result = applyOps(h.row.data!, ops, { by: "human", id: "editor", at: 0 }); h.row = { ...h.row, revision: 2, data: { ...result.page, revision: 2 } };
    return { revision: 2, results: result.results };
  });
  await act(async () => { window.dispatchEvent(new Event("online")); await settle(); });
  expect(h.row.data?.blocks[0].html).toBe("Offline draft");
  await unmount(); await mount(); expect(container.textContent).toContain("Offline draft");
});
it("waits for an in-flight save before reopening and never applies its old account callbacks", async () => {
  await mount(); edit("Account A draft");
  let finish!: (reply: unknown) => void; h.push.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1201); }); await unmount();
  act(() => useAuthStore.setState({ user: { id: "other" } as User })); await mount();
  expect(container.textContent).toContain("Saved"); expect(container.textContent).not.toContain("Account A draft");
  await act(async () => { finish({ revision: 2, results: [] }); await settle(); });
  expect(container.textContent).toContain("Saved");
  expect(h.scopes.at(-1)).toBe("other:owner:shared:shared");
});
it("preserves a revoked editor's pending work for recovery and stops sending", async () => {
  await mount(); edit("Keep my draft"); h.access = null;
  await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); await vi.advanceTimersByTimeAsync(1201); });
  expect(container.textContent).toContain("no longer shared"); expect(h.push).not.toHaveBeenCalled();
  expect(useStore.getState().pages.shared).toBeUndefined();
  expect(pageRecoveryCopies("editor", "shared")?.[0].page.blocks[0].html).toBe("Keep my draft");
});
it("keeps rejected snapshots account scoped across reloads and does not lose work if storage fails", () => {
  savePageRecovery("editor", page({ id: "shared", title: "Local recovery" }));
  usePageRecoveries.setState({ copies: {} }); loadPageRecoveries("other", "shared");
  expect(pageRecoveryCopies("other", "shared")).toEqual([]);
  loadPageRecoveries("editor", "shared"); expect(pageRecoveryCopies("editor", "shared")?.[0].page.title).toBe("Local recovery");
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Full"); });
  expect(() => savePageRecovery("editor", page({ id: "shared" }))).toThrow("Full"); write.mockRestore();
  expect(useStore.getState().pages.shared).toBeUndefined();
});
