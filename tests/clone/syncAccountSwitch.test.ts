// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { useStore } from "@/lib/store";
import { discardLocalCopy, initSync, settleBeforeSignOut, stopSync, useSyncConflict } from "@/lib/sync";
import { foreignPageIds } from "@/lib/foreignPages";
import { page } from "./fixtures";

type Row = Record<string, unknown>;
interface Fake { workspaces: Row[]; pages: Row[]; inserted: Row[]; writes: string[]; failRpc: boolean }
const h = vi.hoisted(() => ({ fake: null as unknown as Fake, client: null as unknown, cleared: [] as string[] }));

vi.mock("@/lib/supabase", () => ({ getSupabase: () => h.client }));
vi.mock("@/lib/opsQueue", async (original) => {
  const actual = await original<typeof import("@/lib/opsQueue")>();
  class TestQueue extends actual.MemoryQueue { readonly ready = Promise.resolve(); async close(): Promise<void> {} }
  return { ...actual, IndexedDbQueue: TestQueue, clearStoredOps: async () => { h.cleared.push("ops"); } };
});
vi.mock("@/lib/fileStore", async (original) => ({
  ...await original<typeof import("@/lib/fileStore")>(),
  onFileSyncStart: () => {}, onFileSyncStop: () => {}, hasPendingUploads: () => false,
  clearLocalFiles: async () => { h.cleared.push("files"); },
}));

function query(table: string) {
  const filters: [string, unknown][] = [];
  let created: Row | null = null;
  const rows = (): Row[] => {
    if (created) return [created];
    const source = table === "workspaces" ? h.fake.workspaces : table === "pages" ? h.fake.pages : [];
    return source.filter((row) => filters.every(([key, value]) => row[key] === value));
  };
  const builder: unknown = new Proxy({}, {
    get(_, key) {
      if (key === "then") return (resolve: (value: unknown) => void) => resolve({ data: rows(), error: null });
      if (key === "single" || key === "maybeSingle") return async () => ({ data: rows()[0] ?? null, error: null });
      if (key === "eq") return (column: string, value: unknown) => { filters.push([column, value]); return builder; };
      if (key === "insert") return (row: Row) => {
        if (table === "workspaces") { created = { ...row, id: "ws-new", revision: 1 }; h.fake.workspaces.push(created); }
        if (table === "pages") { created = { ...row, revision: 1, updated_at: new Date().toISOString(), deleted_at: null }; h.fake.inserted.push(row); h.fake.pages.push(created); }
        return builder;
      };
      if (key === "update" || key === "delete") return () => { h.fake.writes.push(`${table}.${String(key)}`); return builder; };
      return () => builder;
    },
  });
  return builder;
}
function client() {
  const channel: unknown = new Proxy({}, { get: () => () => channel });
  return {
    from: query,
    channel: () => channel, removeChannel: async () => {}, getChannels: () => [],
    rpc: async (name: string) => {
      h.fake.writes.push(name);
      return h.fake.failRpc ? { data: null, error: new Error("offline") } : { data: { revision: 2, results: [] }, error: null };
    },
  };
}
const user = (id: string) => ({ id }) as User;
const stale = () => page({ id: "other-account-page", title: "Someone else's page", createdAt: 1, updatedAt: 2 });
const cloudRow = (id: string, title: string): Row => ({ id, workspace_id: "ws-b", parent_id: null, revision: 3, updated_at: new Date().toISOString(), deleted_at: null, published: false, data: page({ id, title }) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  h.fake = { workspaces: [], pages: [], inserted: [], writes: [], failRpc: false };
  h.client = client(); h.cleared.length = 0; foreignPageIds.clear();
  useSyncConflict.setState({ prompt: null });
  useStore.getState().clearLocalWorkspace();
});
afterEach(() => { stopSync(); });

it("starts a new account from the default pages, without offering another account's copy", async () => {
  useStore.setState({ pages: { [stale().id]: stale() }, rootOrder: [stale().id], syncUserId: "user-a", syncWorkspaceId: "ws-a" });
  await initSync(user("user-b"));
  await sleep(30);
  const state = useStore.getState();
  expect(useSyncConflict.getState().prompt).toBeNull();
  expect(state.pages[stale().id]).toBeUndefined();
  expect(state.syncUserId).toBe("user-b");
  expect(h.fake.inserted.map((row) => row.id)).not.toContain(stale().id);
  expect(h.fake.inserted.map((row) => (row.data as { title: string }).title)).toContain("Agent Tasks");
  expect(h.fake.workspaces[0].root_order).not.toContain(stale().id);
  expect(h.fake.writes).toEqual([]);
  expect(h.cleared).toEqual(expect.arrayContaining(["ops", "files"]));
});

it("starts an existing account from its own cloud pages", async () => {
  h.fake.workspaces.push({ id: "ws-b", owner_id: "user-b", revision: 1, root_order: ["mine"], settings: null, synced_blocks: {} });
  h.fake.pages.push(cloudRow("mine", "My page"));
  useStore.setState({ pages: { [stale().id]: stale() }, rootOrder: [stale().id], syncUserId: "user-a", syncWorkspaceId: "ws-a" });
  await initSync(user("user-b"));
  const state = useStore.getState();
  expect(useSyncConflict.getState().prompt).toBeNull();
  expect(Object.keys(state.pages)).toEqual(["mine"]);
  expect(h.fake.inserted).toEqual([]);
});

it("still asks a person with local pages and no account yet", async () => {
  h.fake.workspaces.push({ id: "ws-b", owner_id: "user-b", revision: 1, root_order: ["mine"], settings: null, synced_blocks: {} });
  h.fake.pages.push(cloudRow("mine", "My page"));
  const own = page({ id: "guest-page", title: "Written before signing in", createdAt: 1, updatedAt: 2 });
  useStore.setState({ pages: { [own.id]: own }, rootOrder: [own.id], syncUserId: null, syncWorkspaceId: null });
  const started = initSync(user("user-b"));
  await vi.waitFor(() => expect(useSyncConflict.getState().prompt).not.toBeNull());
  useSyncConflict.getState().prompt!.resolve("server");
  await started;
  expect(Object.keys(useStore.getState().pages)).toEqual(["mine"]);
});

it("reports whether every edit reached the cloud", async () => {
  await initSync(user("user-b"));
  expect(await settleBeforeSignOut(200)).toBe(true);
  const [id] = useStore.getState().rootOrder;
  h.fake.failRpc = true;
  useStore.getState().updatePage(id, { title: "Edited without a connection" });
  expect(await settleBeforeSignOut(200)).toBe(false);
});

it("clears the local copy without sending any deletion to the cloud", async () => {
  await initSync(user("user-b"));
  await sleep(0);
  h.fake.writes.length = 0;
  const before = new Set(Object.keys(useStore.getState().pages));
  await discardLocalCopy();
  await sleep(0);
  const state = useStore.getState();
  expect(Object.keys(state.pages).some((id) => before.has(id))).toBe(false);
  expect(state.syncUserId).toBeNull();
  expect(state.syncWorkspaceId).toBeNull();
  expect(h.fake.writes).toEqual([]);
  expect(h.cleared).toEqual(expect.arrayContaining(["ops", "files"]));
});
