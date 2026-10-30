import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { approveConsent, connectedApps, denyConsent, disconnectApp, hostOf, loadConsent, safeRedirect, trustedHumanRedirect } from "@/lib/agentConsent";

function fake() {
  const oauth = { getAuthorizationDetails: vi.fn(), approveAuthorization: vi.fn(), denyAuthorization: vi.fn(), revokeGrant: vi.fn() };
  const rpc = vi.fn().mockResolvedValue({ data: { client_id: "c", client_name: "App", redirect_uri: "https://claude.ai/cb" }, error: null });
  const invoke = vi.fn();
  return { oauth, rpc, invoke, client: { auth: { oauth }, functions: { invoke }, rpc } as unknown as SupabaseClient };
}
describe("OAuth consent", () => {
  it.each(["evilapp://claude.ai/cb", "web+evil://claude.ai/cb", "intent://claude.ai/cb", "http://127.0.0.1:9/cb", "http://localhost:3000/cb"])
    ("shows the entire non-HTTPS destination %s", (uri) => expect(hostOf(uri)).toBe(uri));
  it("reads details before asking, showing the real redirect host", async () => {
    const f = fake();
    f.invoke.mockResolvedValue({ data: { client: { id: "c", name: "Claude" },
      redirect_uri: "https://trusted.test@actual.test/cb", user: { email: "me@test.local" } }, error: null });
    expect(await loadConsent(f.client, "a", "agent")).toEqual({ kind: "ask", authorizationId: "a", clientId: "c", clientName: "Claude",
      redirectUri: "https://trusted.test@actual.test/cb", redirectHost: "https://actual.test", redirectIsApp: false, email: "me@test.local" });
    expect(f.invoke).toHaveBeenCalledWith("agent-admin", { body: { action: "oauth_read", authorization_id: "a", agent_id: "agent" } });
    expect(f.oauth.getAuthorizationDetails).not.toHaveBeenCalled();
  });
  it("returns the already-consented redirect and propagates expired requests", async () => {
    const f = fake();
    f.invoke.mockResolvedValueOnce({ data: { redirect_url: "cursor://cb" }, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("expired") });
    expect(await loadConsent(f.client, "a", "agent")).toEqual({ kind: "redirect", url: "cursor://cb" });
    await expect(loadConsent(f.client, "b", "agent")).rejects.toThrow("expired");
  });
  it("delegates agent approval to the server and never uses human Auth to approve it", async () => {
    const f = fake();
    f.invoke.mockResolvedValue({ data: { redirect_url: "https://app.test/cb" }, error: null });
    expect(await approveConsent(f.client, "a", "c", "agent")).toBe("https://app.test/cb");
    expect(f.invoke).toHaveBeenCalledWith("agent-admin", { body: { action: "oauth_approve", authorization_id: "a", agent_id: "agent" } });
    f.invoke.mockResolvedValue({ error: new Error("forbidden") });
    await expect(approveConsent(f.client, "a", "c", "agent")).rejects.toThrow("forbidden");
    expect(f.oauth.approveAuthorization).not.toHaveBeenCalled();
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
    const f = fake(); f.oauth.revokeGrant.mockResolvedValue({ error: null }); f.invoke.mockResolvedValue({ data: { disconnected: true }, error: null });
    await disconnectApp(f.client, "c", true, "agent");
    expect(f.invoke).toHaveBeenCalledWith("agent-admin", { body: { action: "oauth_disconnect", client_id: "c", agent_id: "agent" } });
    expect(f.oauth.revokeGrant).not.toHaveBeenCalled();
    f.rpc.mockClear();
    await disconnectApp(f.client, "c", false);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(["evilapp://claude.ai/cb", "http://claude.ai/cb", "https://claude.ai.evil.test/cb", "https://claude.ai:444/cb", "http://localhost/cb"])("refuses As you for %s and denies even remembered consent", async (uri) => {
    const f = fake(); f.rpc.mockResolvedValue({ data: { client_id: "c", redirect_uri: uri }, error: null });
    f.oauth.revokeGrant.mockResolvedValue({ error: null });
    f.oauth.getAuthorizationDetails.mockResolvedValue({ data: { client: { id: "c" }, redirect_uri: uri }, error: null });
    f.oauth.denyAuthorization.mockResolvedValue({ data: { redirect_url: `${uri}?error=access_denied` }, error: null });
    await expect(loadConsent(f.client, "a", null)).rejects.toThrow("choosing As an agent");
    expect(f.oauth.denyAuthorization).toHaveBeenCalledWith("a", { skipBrowserRedirect: true });
    expect(f.oauth.revokeGrant.mock.invocationCallOrder[0]).toBeLessThan(f.oauth.getAuthorizationDetails.mock.invocationCallOrder[0]);
    expect(f.oauth.approveAuthorization).not.toHaveBeenCalled(); expect(trustedHumanRedirect(uri)).toBe(false);
  });
  it.each(["https://claude.ai/cb", "https://chatgpt.com/cb"])("allows and links remembered human consent only for %s", async (uri) => {
    const f = fake(); f.rpc.mockResolvedValue({ data: { client_id: "c", client_name: "Trusted", redirect_uri: uri }, error: null });
    f.oauth.getAuthorizationDetails.mockResolvedValue({ data: { redirect_url: `${uri}?code=x` }, error: null });
    expect(await loadConsent(f.client, "a", null)).toEqual({ kind: "redirect", url: `${uri}?code=x` });
    expect(f.rpc).toHaveBeenCalledWith("set_oauth_app", { p_client_id: "c", p_agent_id: null, p_client_name: "Trusted", p_redirect_uri: uri });
    expect(trustedHumanRedirect(uri)).toBe(true);
  });
  it("lists agent apps from their links without human OAuth grants", async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ client_id: "c", client_name: "Agent app", redirect_uri: "cursor://cb", agent_id: "a", as_human: false, revoked_at: null, agents: { name: "Worker" } }], error: null });
    const client = { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient;
    expect(await connectedApps(client)).toEqual([{ clientId: "c", name: "Agent app", agentId: "a", agentName: "Worker", redirectHost: "cursor://cb", linked: true, revoked: false }]);
  });
});
