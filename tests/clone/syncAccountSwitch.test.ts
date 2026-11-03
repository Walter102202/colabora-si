// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { TRAMA_COVERS, safeCover } from "@/lib/cover";
import { useStore } from "@/lib/store";
import { discardLocalCopy, flush, initSync, settleBeforeSignOut, stopSync, useSyncConflict } from "@/lib/sync";
import { applyOps, type PageOp } from "@/lib/pageOps";
import type { Page } from "@/lib/types";
import { foreignPageIds } from "@/lib/foreignPages";
import { canUndo, clearHistory, initHistory, undo } from "@/lib/history";
import { b, page } from "./fixtures";

type Row = Record<string, unknown>;
interface Fake { workspaces: Row[]; pages: Row[]; inserted: Row[]; writes: string[]; failRpc: boolean }
const h = vi.hoisted(() => ({ fake: null as unknown as Fake, client: null as unknown, cleared: [] as string[], readSynced: vi.fn(), changes: new Map<string, (payload: { new: Row }) => void>(), synced: {} as Record<string, unknown>, sourceAtWrite: [] as boolean[] }));

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
  const channel: unknown = new Proxy({}, { get: (_, key) => key === "on" ? (_event: string, filter: { table: string }, callback: (payload: { new: Row }) => void) => { h.changes.set(filter.table, callback); return channel; } : () => channel });
  return {
    from: query,
    channel: () => channel, removeChannel: async () => {}, getChannels: () => [],
    rpc: async (name: string, args: Row) => {
      if (name === "read_workspace_synced_blocks") return h.readSynced(args);
      h.fake.writes.push(name);
      if (name === "apply_workspace_ops" && !h.fake.failRpc) for (const op of args.p_ops as Row[]) {
        if (op.op === "synced_set") {
          h.sourceAtWrite.push(h.fake.pages.some((row) => (row.data as { blocks: { id: string }[] })?.blocks?.some((block) => block.id === op.key)));
          if (op.blocks === null) delete h.synced[String(op.key)]; else h.synced[String(op.key)] = op.blocks;
        }
      }
      if (name === "accept_invitation") return { data: "ws-b", error: null };
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
  h.synced = {}; h.sourceAtWrite.length = 0; h.readSynced.mockReset().mockImplementation(async () => ({ data: structuredClone(h.synced), error: null })); h.changes.clear();
  h.client = client(); h.cleared.length = 0; foreignPageIds.clear();
  useSyncConflict.setState({ prompt: null });
  sessionStorage.clear();
  useStore.getState().clearLocalWorkspace();
});
afterEach(() => { stopSync(); });

it.each(["queued", "sent", "inflight"] as const)("undo preserves the restored body when a cloud deletion is %s", async (phase) => {
  await initSync(user("person")); await sleep(0);
  const id = useStore.getState().createPage(null, { title: "Restore me", blocks: [b("paragraph", { html: "Original content" })] });
  await flush();
  const backend = h.client as ReturnType<typeof client>, originalFrom = backend.from, originalRpc = backend.rpc;
  const server = h.fake.pages.find((row) => row.id === id)!;
  let release!: () => void, started!: () => void;
  const deletionStarted = new Promise<void>((resolve) => { started = resolve; });
  const deletionRelease = new Promise<void>((resolve) => { release = resolve; });
  backend.from = (table) => {
    const query = originalFrom(table);
    if (table !== "pages") return query;
    return new Proxy(query as object, { get(target, key) {
      if (key !== "update") return Reflect.get(target, key);
      return () => {
        const update = { eq: () => update, select: () => update, maybeSingle: async () => {
          started(); if (phase === "inflight") await deletionRelease;
          server.data = null; server.revision = Number(server.revision) + 1; server.deleted_at = new Date().toISOString();
          return { data: { revision: server.revision, updated_at: new Date().toISOString() }, error: null };
        } }; return update;
      };
    } });
  };
  backend.rpc = async (name, args) => {
    if (name !== "apply_page_ops") return originalRpc(name, args);
    const replacement = (args.p_ops as PageOp[]).find((op) => op.op === "replace_page");
    if (!replacement || replacement.revision !== server.revision) return { data: null, error: { code: "PT409", message: "page_conflict" } as unknown as Error };
    server.data = replacement.page; server.revision = Number(server.revision) + 1; server.deleted_at = null;
    return { data: { revision: Number(server.revision), results: [] }, error: null };
  };
  initHistory(); clearHistory(); useStore.getState().permanentlyDelete(id);
  let deleting: Promise<void> | undefined;
  if (phase !== "queued") { deleting = flush(); await deletionStarted; if (phase === "sent") await deleting; }
  undo(); if (phase === "inflight") { release(); await deleting; }
  await flush();
  expect((server.data as Page | null)?.blocks[0].html).toBe("Original content");
  expect(useStore.getState().pages[id]?.blocks[0].html).toBe("Original content");
});

it("persists a trash backup before dropping the old database attachment reference", async () => {
  await initSync(user("user-b")); await sleep(0);
  const s = useStore.getState(), dbId = s.createDatabasePage();
  s.addProperty(dbId, { name: "Files", type: "files" });
  const prop = useStore.getState().pages[dbId].database!.properties.at(-1)!;
  const rowId = s.addRow(dbId, { cells: { [prop.id]: [{ fileId: "protected-file" }] } });
  const rowPageId = useStore.getState().pages[dbId].database!.rows[0].pageId;
  await flush();
  const backend = h.client as ReturnType<typeof client>, original = backend.rpc;
  let backupSaved = false;
  const writes: string[] = [];
  backend.rpc = async (name, args) => {
    if (name !== "apply_page_ops") return original(name, args);
    const ops = args.p_ops as PageOp[], id = String(args.p_page_id);
    if (id === dbId && ops.some((op) => op.op === "db_row_delete") && !backupSaved) return { data: null, error: new Error("last attachment reference removed before backup") };
    const server = h.fake.pages.find((r) => r.id === id)!;
    const result = applyOps(server.data as Page, ops, { by: "human", id: "user-b", at: Date.now() });
    server.data = result.page; server.revision = Number(server.revision) + 1;
    if (id === rowPageId) backupSaved = !!result.page.rowOrigin;
    writes.push(id);
    return { data: { revision: Number(server.revision), results: result.results }, error: null };
  };
  s.deleteRow(dbId, rowId); await flush();
  expect(writes.slice(0, 2)).toEqual([rowPageId, dbId]);
  expect((h.fake.pages.find((r) => r.id === rowPageId)!.data as Page).rowOrigin!.row.cells[prop.id]).toEqual([{ fileId: "protected-file" }]);
});

it("starts a new account from the default pages, without offering another account's copy", async () => {
  useStore.setState({ pages: { [stale().id]: stale() }, rootOrder: [stale().id], syncUserId: "user-a", syncWorkspaceId: "ws-a" });
  await initSync(user("user-b"));
  await sleep(30);
  const state = useStore.getState();
  expect(useSyncConflict.getState().prompt).toBeNull();
  expect(state.pages[stale().id]).toBeUndefined();
  expect(state.syncUserId).toBe("user-b");
  expect(h.fake.inserted.map((row) => row.id)).not.toContain(stale().id);
  const starters = h.fake.inserted.map((row) => row.data as Page);
  expect(starters.map((p) => p.title).sort()).toEqual(["Agent Tasks", "Connect your agents", "Getting started", "Working with agents"]);
  const savedCovers = starters.map((p) => safeCover(p.cover));
  expect(new Set(savedCovers).size).toBe(4);
  for (const cover of savedCovers) expect(TRAMA_COVERS.some((preset) => preset.url === cover)).toBe(true);
  expect(h.fake.workspaces[0].root_order).not.toContain(stale().id);
  expect(h.fake.writes).toEqual([]);
  expect(h.cleared).toEqual(expect.arrayContaining(["ops", "files"]));
});

it("removes the previous account from IndexedDB before bootstrapping the next one", async () => {
  const storage = await import("@/lib/localPersistence"), { startTestWriter } = await import("./localHelpers");
  const fake = await startTestWriter();
  try {
    useStore.setState({ pages: { [stale().id]: stale() }, rootOrder: [stale().id], syncUserId: "user-a", syncWorkspaceId: "ws-a" });
    await storage.flushLocalWrites();
    expect(fake.dump("bodies")).toContainEqual(expect.objectContaining({ id: stale().id }));
    await initSync(user("user-b")); await sleep(0); await storage.flushLocalWrites();
    for (const name of ["meta", "bodies", "search", "kv"]) expect(JSON.stringify(fake.dump(name))).not.toMatch(/other-account-page|user-a|ws-a/);
    expect(useStore.getState().syncUserId).toBe("user-b");
    expect(h.fake.inserted.map((row) => row.id)).not.toContain(stale().id);
    expect(h.fake.writes).toEqual([]);
  } finally { storage.stopLocalPersistence(); }
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

it.each([false, true])("joining an invited workspace preserves its pages and merges only meaningful local content (%s)", async (meaningful) => {
  h.fake.workspaces.push({ id: "ws-b", owner_id: "owner", revision: 1, root_order: ["owner-page"], settings: null, synced_blocks: {} });
  const existing = cloudRow("owner-page", "Getting started");
  const ownerCover = "https://example.test/owner-cover.jpg";
  h.fake.pages.push({ ...existing, data: { ...(existing.data as Page), cover: ownerCover } });
  if (meaningful) {
    const local = page({ id: "local-work", title: "My notes", createdAt: 1, updatedAt: 2 });
    useStore.setState({ pages: { [local.id]: local }, rootOrder: [local.id], syncUserId: null, syncWorkspaceId: null });
  }
  sessionStorage.setItem("colabora-invitation", "workspace-token");
  await initSync(user("invitee"));
  await sleep(30);
  const expected = meaningful ? ["owner-page", "local-work"] : ["owner-page"];
  expect(Object.keys(useStore.getState().pages).sort()).toEqual([...expected].sort());
  expect(useStore.getState().rootOrder).toEqual(expected);
  expect(useStore.getState().pages["owner-page"].cover).toBe(ownerCover);
  expect(h.fake.inserted.map((row) => row.id)).toEqual(meaningful ? ["local-work"] : []);
  expect(h.fake.pages.find((row) => row.id === "owner-page")?.deleted_at).toBeNull();
  expect(useSyncConflict.getState().prompt).toBeNull();
  expect(sessionStorage.getItem("colabora-invitation")).toBeNull();
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

it("leaves nothing of the previous account to undo", async () => {
  initHistory();
  useStore.setState({ pages: { [stale().id]: stale() }, rootOrder: [stale().id], syncUserId: "user-a", syncWorkspaceId: "ws-a" });
  useStore.setState({ rootOrder: [] });
  await sleep(400);
  useStore.setState({ rootOrder: [stale().id] });
  expect(canUndo()).toBe(true);
  await initSync(user("user-b"));
  await sleep(30);
  const restored: boolean[] = [];
  while (canUndo()) { undo(); restored.push(stale().id in useStore.getState().pages); }
  expect(restored).not.toContain(true);
});

it("creates source pages before publishing initial synced content and reads only the authorized map", async () => {
  const source = page({ id: "source-page", blocks: [b("synced", { id: "original" })], createdAt: 1, updatedAt: 2 });
  const blocks = [b("paragraph", { html: "Local synced text" })];
  useStore.setState({ pages: { [source.id]: source }, rootOrder: [source.id], syncedBlocks: { original: blocks }, syncUserId: null, syncWorkspaceId: null });
  await initSync(user("user-b")); await sleep(30);
  expect(h.fake.workspaces[0].synced_blocks).toEqual({});
  expect(h.sourceAtWrite).toEqual([true]);
  expect(useStore.getState().syncedBlocks).toEqual({ original: blocks });
  expect(h.readSynced).toHaveBeenCalledWith({ p_workspace_id: "ws-new" });
});
it("rebases pending synced edits over an authorized read and ignores the raw workspace cache", async () => {
  const remote = [b("paragraph", { html: "Authorized" })], local = [b("paragraph", { html: "Pending local" })];
  h.synced = { original: remote };
  await initSync(user("user-b"));
  expect(useStore.getState().syncedBlocks).toEqual({ original: remote });
  let finish!: (value: unknown) => void;
  h.readSynced.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  h.changes.get("workspaces")!({ new: { ...h.fake.workspaces[0], revision: 10, synced_blocks: {} } });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  useStore.setState({ syncedBlocks: { original: local } });
  finish({ data: {}, error: null }); await sleep(0);
  expect(useStore.getState().syncedBlocks).toEqual({ original: local });
});
it("discards an authorized synced-content read when its account changes", async () => {
  await initSync(user("user-a"));
  let finish!: (value: unknown) => void;
  h.readSynced.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  h.changes.get("workspaces")!({ new: { ...h.fake.workspaces[0], revision: 10, synced_blocks: {} } });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  stopSync(); h.fake.workspaces = []; h.fake.pages = [];
  await initSync(user("user-b"));
  finish({ data: { secret: [b("paragraph", { html: "Old account" })] }, error: null }); await sleep(0);
  expect(useStore.getState().syncedBlocks).toEqual({});
});
