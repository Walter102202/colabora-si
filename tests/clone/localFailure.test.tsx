// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import type { Root } from "react-dom/client";
import { installFakeIndexedDb } from "./fakeIndexedDb";
import { b, page } from "./fixtures";

const h = vi.hoisted(() => ({ backend: false, client: null as unknown }));
const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage");
vi.mock("@/lib/supabase", () => ({ isSupabaseConfigured: () => h.backend, getSupabase: () => h.client }));
vi.mock("@/lib/fileStore", async (original) => ({ ...await original<typeof import("@/lib/fileStore")>(), onFileSyncStart: () => {}, onFileSyncStop: () => {}, hasPendingUploads: () => false }));
let root: Root | undefined, host: HTMLDivElement, act: typeof import("react").act;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear(); h.backend = false; h.client = null;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; host.remove();
  (await import("@/lib/sync")).stopSync(); (await import("@/lib/localPersistence")).stopLocalPersistence();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (originalStorage) Object.defineProperty(navigator, "storage", originalStorage); else Reflect.deleteProperty(navigator, "storage");
});
async function modules() {
  return { storage: await import("@/lib/localPersistence"), store: (await import("@/lib/store")).useStore };
}
async function ready() {
  const fake = installFakeIndexedDb(), result = await modules();
  const p = page({ id: "page", blocks: [b("paragraph", { id: "block", html: "Original" })] });
  result.store.setState({ pages: { page: p }, rootOrder: [p.id] });
  await result.storage.hydrateWorkspace(); return { ...result, fake };
}
const beforeUnload = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };

it("keeps a blocked IndexedDB workspace usable in memory and warns only for unsaved edits", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); } });
  const { storage, store } = await modules(); await storage.hydrateWorkspace();
  expect(storage.useLocalHealth.getState().health).toBe("unavailable"); expect(storage.diskAvailable()).toBe(false);
  expect(Object.keys(store.getState().pages).length).toBeGreaterThan(0); expect(beforeUnload()).toBe(false);
  store.getState().createPage(); expect(storage.hasUnsavedLocalChanges()).toBe(true); expect(beforeUnload()).toBe(true);
  storage.setCloudCheck(() => true); expect(beforeUnload()).toBe(false);
});

it("retains quota-failed edits, warns on leaving and saves them on retry", async () => {
  const { storage, store, fake } = await ready();
  fake.failNext("QuotaExceededError"); store.getState().updateBlock("page", "block", { html: "Keep me" });
  await expect(storage.flushLocalWrites()).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(storage.useLocalHealth.getState().health).toBe("full"); expect(storage.hasPendingLocalWrites()).toBe(true);
  expect(store.getState().pages.page.blocks[0].html).toBe("Keep me"); expect(beforeUnload()).toBe(true);
  await storage.flushLocalWrites();
  expect(fake.dump("bodies")).toEqual([expect.objectContaining({ blocks: [expect.objectContaining({ html: "Keep me" })] })]);
  expect(storage.useLocalHealth.getState().health).toBe("ok"); expect(beforeUnload()).toBe(false);
});

it("reopens once after a generic write failure and retries without dropping pending content", async () => {
  const { storage, store, fake } = await ready(), open = vi.spyOn(indexedDB, "open");
  fake.failNext("UnknownError"); store.getState().updateBlock("page", "block", { html: "Retry me" });
  await expect(storage.flushLocalWrites()).rejects.toMatchObject({ name: "UnknownError" });
  expect(storage.useLocalHealth.getState().health).toBe("failing");
  await vi.advanceTimersByTimeAsync(1000); await storage.flushLocalWrites();
  expect(open).toHaveBeenCalledTimes(1); expect(storage.useLocalHealth.getState().health).toBe("ok");
  expect(fake.dump("bodies")).toEqual([expect.objectContaining({ blocks: [expect.objectContaining({ html: "Retry me" })] })]);
});

it.each([false, true])("requests persistent browser storage once only without a backend (%s)", async (backend) => {
  h.backend = backend; const persist = vi.fn().mockResolvedValue(true);
  Object.defineProperty(navigator, "storage", { configurable: true, value: { persist } });
  const { storage, store } = await ready();
  store.getState().updateBlock("page", "block", { html: "One" }); await storage.flushLocalWrites();
  store.getState().updateBlock("page", "block", { html: "Two" }); await storage.flushLocalWrites();
  expect(persist).toHaveBeenCalledTimes(backend ? 0 : 1);
});

it.each([
  ["unavailable", "This browser isn't keeping a local copy."],
  ["full", "Browser storage is full."],
  ["failing", "Changes can't be saved to this browser right now."],
  ["ok", ""],
] as const)("shows the %s health with working backup navigation", async (health, text) => {
  installFakeIndexedDb(); const { storage } = await modules(); storage.useLocalHealth.setState({ health });
  const react = await import("react"); act = react.act;
  const { createRoot } = await import("react-dom/client"), { MemoryRouter, useLocation } = await import("react-router");
  const { default: Banner } = await import("@/components/LocalStorageBanner");
  function Location() { return <output>{useLocation().search}</output>; }
  root = createRoot(host); await act(async () => root!.render(<MemoryRouter><Banner /><Location /></MemoryRouter>));
  if (!text) { expect(host.querySelector('[role="alert"]')).toBeNull(); return; }
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(text);
  if (health === "full" || health === "unavailable") {
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Export backup")!.click());
    expect(host.querySelector("output")?.textContent).toBe("?settings=data");
  }
});

it("explains cloud safety in memory mode with a backend", async () => {
  h.backend = true; installFakeIndexedDb(); const { storage } = await modules(); storage.useLocalHealth.setState({ health: "unavailable" });
  act = (await import("react")).act;
  const { createRoot } = await import("react-dom/client"), { MemoryRouter } = await import("react-router");
  const { default: Banner } = await import("@/components/LocalStorageBanner");
  root = createRoot(host); await act(async () => root!.render(<MemoryRouter><Banner /></MemoryRouter>));
  expect(host.textContent).toContain("Anything already synced is safe in the cloud.");
});

it.each([undefined, 2 * 1024 * 1024])("shows browser storage estimates in Settings when available (%s)", async (usage) => {
  installFakeIndexedDb();
  Object.defineProperty(navigator, "storage", { configurable: true, value: usage === undefined ? undefined : { estimate: async () => ({ usage }) } });
  act = (await import("react")).act;
  const { createRoot } = await import("react-dom/client"), { MemoryRouter } = await import("react-router");
  const { default: Settings } = await import("@/components/SettingsModal");
  root = createRoot(host); await act(async () => root!.render(<MemoryRouter><Settings tab="data" onClose={() => {}} onTabChange={() => {}} /></MemoryRouter>));
  expect(host.textContent).not.toContain("localStorage");
  if (usage === undefined) expect(host.textContent).not.toContain("MB on this device");
  else expect(host.textContent).toContain("2.0 MB on this device");
});

it("sends operations with a memory queue when IndexedDB is blocked", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); } });
  h.backend = true;
  const row = { id: "page", revision: 1, deleted_at: null, updated_at: new Date().toISOString(), data: page({ id: "page", revision: 1 }) };
  const rpc = vi.fn(async () => ({ data: { revision: 2, results: [] }, error: null }));
  const query: unknown = new Proxy({}, { get: (_, key) => key === "then" ? (resolve: (value: unknown) => void) => resolve({ data: [], error: null }) : key === "maybeSingle" || key === "single" ? async () => ({ data: row, error: null }) : () => query });
  const channel: unknown = new Proxy({}, { get: () => () => channel });
  h.client = { from: () => query, rpc, channel: () => channel, removeChannel: async () => {} };
  const { storage, store } = await modules(); await storage.hydrateWorkspace();
  store.setState({ pages: { page: row.data }, rootOrder: ["page"], syncUserId: "person", syncWorkspaceId: "workspace", reminders: [] });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const sync = await import("@/lib/sync"); await sync.initSync({ id: "person" } as User);
  store.getState().updatePage("page", { title: "Memory edit" });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); await sync.flush();
  expect(rpc).toHaveBeenCalledWith("apply_page_ops", expect.objectContaining({ p_page_id: "page", p_ops: [{ op: "set_page", patch: { title: "Memory edit" } }] }));
  expect(sync.useSyncStatus.getState().status).toBe("synced");
  store.getState().updatePage("page", { title: "New unsent edit" });
  expect(sync.useSyncStatus.getState().status).toBe("synced");
  expect(storage.hasUnsavedLocalChanges()).toBe(true);
  expect(beforeUnload()).toBe(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(beforeUnload()).toBe(false);
});
