// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const upsert = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "person" } } }) },
  from: () => ({ upsert }),
}) }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); upsert.mockClear(); });

it.each([["https://fcm.googleapis.com/wp/token", "on", 1], ["https://fcm.googleapis.com.evil.com/push", "off", 0]] as const)(
  "checks %s before registering the subscription", async (endpoint, state, saved) => {
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "AAAA");
    const unsubscribe = vi.fn(async () => true);
    const sub = { endpoint, getKey: () => new Uint8Array(16).buffer, unsubscribe };
    const registration = { pushManager: { getSubscription: async () => sub } };
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("navigator", { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } });
    const { enablePush } = await import("@/lib/push");
    expect(await enablePush()).toBe(state);
    expect(upsert).toHaveBeenCalledTimes(saved);
    expect(unsubscribe).toHaveBeenCalledTimes(1 - saved);
  },
);
