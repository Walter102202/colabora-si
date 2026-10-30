import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { approveConsent, denyConsent, disconnectApp, hostOf, loadConsent, safeRedirect } from "@/lib/agentConsent";

function fake() {
  const oauth = { getAuthorizationDetails: vi.fn(), approveAuthorization: vi.fn(), denyAuthorization: vi.fn(), revokeGrant: vi.fn() };
  const rpc = vi.fn().mockResolvedValue({ error: null });
  return { oauth, rpc, client: { auth: { oauth }, rpc } as unknown as SupabaseClient };
}
describe("OAuth consent", () => {
  it.each(["evilapp://claude.ai/cb", "web+evil://claude.ai/cb", "intent://claude.ai/cb", "http://127.0.0.1:9/cb", "http://localhost:3000/cb"])
    ("shows the entire non-HTTPS destination %s", (uri) => expect(hostOf(uri)).toBe(uri));
  it("reads details before asking, showing the real redirect host", async () => {
    const f = fake();
    f.oauth.getAuthorizationDetails.mockResolvedValue({ data: { client: { id: "c", name: "Claude" },
      redirect_uri: "https://trusted.test@actual.test/cb", user: { email: "me@test.local" } }, error: null });
    expect(await loadConsent(f.client, "a")).toEqual({ kind: "ask", authorizationId: "a", clientId: "c", clientName: "Claude",
      redirectHost: "https://actual.test", redirectIsApp: false, email: "me@test.local" });
    expect(f.oauth.getAuthorizationDetails).toHaveBeenCalledWith("a");
  });
  it("returns the already-consented redirect and propagates expired requests", async () => {
    const f = fake();
    f.oauth.getAuthorizationDetails.mockResolvedValueOnce({ data: { redirect_url: "cursor://cb" }, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("expired") });
    expect(await loadConsent(f.client, "a")).toEqual({ kind: "redirect", url: "cursor://cb" });
    await expect(loadConsent(f.client, "b")).rejects.toThrow("expired");
  });
  it("saves the chosen principal before approval and never approves a failed link", async () => {
    const f = fake();
    f.oauth.approveAuthorization.mockResolvedValue({ data: { redirect_url: "https://app.test/cb" }, error: null });
    expect(await approveConsent(f.client, "a", "c", "agent")).toBe("https://app.test/cb");
    expect(f.rpc).toHaveBeenCalledWith("set_oauth_link", { p_client_id: "c", p_agent_id: "agent" });
    expect(f.rpc.mock.invocationCallOrder[0]).toBeLessThan(f.oauth.approveAuthorization.mock.invocationCallOrder[0]);
    expect(f.oauth.approveAuthorization).toHaveBeenCalledWith("a", { skipBrowserRedirect: true });
    f.rpc.mockResolvedValue({ error: new Error("forbidden") });
    await expect(approveConsent(f.client, "a", "c", null)).rejects.toThrow("forbidden");
    expect(f.oauth.approveAuthorization).toHaveBeenCalledTimes(1);
  });
  it("returns denial without allowing the SDK to navigate", async () => {
    const f = fake();
    f.oauth.denyAuthorization.mockResolvedValue({ data: { redirect_url: "https://app.test/cb?error=access_denied" }, error: null });
    expect(await denyConsent(f.client, "a")).toContain("access_denied");
    expect(f.oauth.denyAuthorization).toHaveBeenCalledWith("a", { skipBrowserRedirect: true });
  });
  it.each(["https://a.test/cb", "http://localhost/cb", "cursor://cb"])("allows redirect %s", (url) => expect(safeRedirect(url)).toBe(url));
  it.each(["javascript:alert(1)", "data:text/html,test", "vbscript:msgbox(1)", "not a URL", "/relative", "\nJaVaScRiPt:alert(1)"])
    ("refuses redirect %s", (url) => expect(safeRedirect(url)).toBeNull());
  it("cuts off a linked session before revoking its OAuth grant", async () => {
    const f = fake(); f.oauth.revokeGrant.mockResolvedValue({ error: null });
    await disconnectApp(f.client, "c", true);
    expect(f.rpc).toHaveBeenCalledWith("revoke_oauth_link", { p_client_id: "c" });
    expect(f.rpc.mock.invocationCallOrder[0]).toBeLessThan(f.oauth.revokeGrant.mock.invocationCallOrder[0]);
    expect(f.oauth.revokeGrant).toHaveBeenCalledWith({ clientId: "c" });
    f.rpc.mockClear();
    await disconnectApp(f.client, "c", false);
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
