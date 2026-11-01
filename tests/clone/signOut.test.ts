// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { signOut } from "@/lib/auth";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  authError: null as Error | null,
  settled: true,
}));

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({ auth: { signOut: async () => { h.calls.push("auth"); return { error: h.authError }; } } }),
}));
vi.mock("@/lib/push", () => ({
  cleanupPushOnSignOut: async () => { h.calls.push("push"); },
  syncPushSubscription: async () => {},
}));
vi.mock("@/lib/sync", () => ({
  settleBeforeSignOut: async () => { h.calls.push("settle"); return h.settled; },
  discardLocalCopy: async () => { h.calls.push("discard"); },
}));

const assign = vi.fn(() => { h.calls.push("assign"); });
const confirm = vi.fn(() => false);

beforeEach(() => {
  h.calls.length = 0; h.authError = null; h.settled = true;
  assign.mockClear(); confirm.mockClear(); confirm.mockReturnValue(false);
  vi.stubGlobal("location", { assign, search: "" });
  vi.stubGlobal("confirm", confirm);
});

it("sends pending edits first and clears the local copy only after the session ends", async () => {
  await signOut();
  expect(h.calls).toEqual(["settle", "push", "auth", "discard", "assign"]);
  expect(confirm).not.toHaveBeenCalled();
});

it("stays signed in when the person keeps their unsynced changes", async () => {
  h.settled = false;
  await signOut();
  expect(confirm).toHaveBeenCalledOnce();
  expect(h.calls).toEqual(["settle"]);
});

it("logs out when the person accepts losing unsynced changes", async () => {
  h.settled = false; confirm.mockReturnValue(true);
  await signOut();
  expect(h.calls).toEqual(["settle", "push", "auth", "discard", "assign"]);
});

it("keeps the local copy when the server refuses the log out", async () => {
  h.authError = new Error("nope");
  await expect(signOut()).rejects.toThrow("nope");
  expect(h.calls).not.toContain("discard");
  expect(assign).not.toHaveBeenCalled();
});
