// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import { installFakeIndexedDb } from "./fakeIndexedDb";

const config = vi.hoisted(() => ({ backend: false }));
vi.mock("@/lib/supabase", () => ({ isSupabaseConfigured: () => config.backend, getSupabase: () => null }));

let root: Root | undefined, host: HTMLDivElement;
let act: typeof import("react").act;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); config.backend = false;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host.remove(); vi.useRealTimers();
});
async function mount() {
  const react = await import("react"); act = react.act;
  const { createRoot } = await import("react-dom/client");
  const { default: Gate } = await import("@/components/HydrationGate");
  const mounted = vi.fn();
  function Child() { react.useEffect(mounted, []); return <div>Workspace ready</div>; }
  root = createRoot(host);
  await act(async () => root!.render(<Gate><Child /></Gate>));
  return mounted;
}

it("does not mount children while hydration is pending and mounts after it completes", async () => {
  installFakeIndexedDb().hangOpen();
  const mounted = await mount();
  expect(mounted).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  const { useLocalHealth } = await import("@/lib/localPersistence");
  await act(async () => useLocalHealth.setState({ health: "ok" }));
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Workspace ready");
});

it("keeps a slow local-only copy gated until the person chooses to continue", async () => {
  installFakeIndexedDb().hangOpen();
  const mounted = await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Opening your local copy is taking longer than usual.");
  expect(host.querySelector("button")?.textContent).toBe("Continue without it");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mounted).not.toHaveBeenCalled();
  await act(async () => host.querySelector("button")!.click());
  expect(mounted).toHaveBeenCalledTimes(1);
  expect((await import("@/lib/localPersistence")).useLocalHealth.getState().health).toBe("unavailable");
});

it("continues in memory after eight seconds when a backend is configured", async () => {
  config.backend = true; installFakeIndexedDb().hangOpen();
  const mounted = await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(7999); });
  expect(mounted).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mounted).toHaveBeenCalledTimes(1);
  expect((await import("@/lib/localPersistence")).diskAvailable()).toBe(false);
});
