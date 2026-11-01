import { describe, expect, it } from "vitest";
import { SET_PASSWORD_MIN, parseInviteLink, passwordProblem, submitPassword, type PasswordAuth } from "@/lib/setPassword";

const link = { tokenHash: "hash", email: "ana@company.co", type: "invite", invite: null };
const ok = { error: null };

function auth(verify: Awaited<ReturnType<PasswordAuth["verifyOtp"]>> = ok, update: Awaited<ReturnType<PasswordAuth["updateUser"]>> = ok) {
  const calls: unknown[] = [];
  const client: PasswordAuth = {
    verifyOtp: async (params) => { calls.push(["verify", params]); return verify; },
    updateUser: async (attrs) => { calls.push(["update", attrs]); return update; },
  };
  return { client, calls };
}

describe("parseInviteLink", () => {
  it("reads the token and the address of an invite", () => {
    expect(parseInviteLink("?token_hash=hash&type=invite", "#ana%40company.co")).toEqual(link);
  });

  it("works without the address", () => {
    expect(parseInviteLink("?token_hash=hash&type=invite", "")).toEqual({ tokenHash: "hash", email: "", type: "invite", invite: null });
  });

  it("does not break on a damaged address", () => {
    expect(parseInviteLink("?token_hash=hash&type=invite", "#%E0%A4%A")).toEqual({ tokenHash: "hash", email: "", type: "invite", invite: null });
  });

  it.each(["", "?token_hash=hash", "?type=invite", "?token_hash=&type=invite", "?token_hash=hash&type=magiclink"])("refuses %s", (search) => {
    expect(parseInviteLink(search, "")).toBeNull();
  });
});

describe("passwordProblem", () => {
  it("asks for the minimum length", () => {
    expect(passwordProblem("short")).toBe(`Use at least ${SET_PASSWORD_MIN} characters.`);
    expect(passwordProblem("a".repeat(SET_PASSWORD_MIN))).toBe("");
  });
});

describe("submitPassword", () => {
  it("spends the token, then sets the password", async () => {
    const { client, calls } = auth();
    expect(await submitPassword(client, "hash", "long enough", false)).toEqual({ kind: "done" });
    expect(calls).toEqual([["verify", { token_hash: "hash", type: "invite" }], ["update", { password: "long enough" }]]);
  });

  it("does not spend a token twice when only the password failed", async () => {
    const { client, calls } = auth();
    expect(await submitPassword(client, "hash", "long enough", true)).toEqual({ kind: "done" });
    expect(calls).toEqual([["update", { password: "long enough" }]]);
  });

  it("treats a spent or expired token as the end of this link", async () => {
    const { client, calls } = auth({ error: { status: 403, code: "otp_expired" } });
    expect(await submitPassword(client, "hash", "long enough", false)).toEqual({ kind: "expired" });
    expect(calls).toHaveLength(1);
  });

  it("keeps the form after a failure the person can retry", async () => {
    const unreachable = auth({ error: { status: 0, name: "AuthRetryableFetchError" } });
    expect(await submitPassword(unreachable.client, "hash", "long enough", false)).toEqual({ kind: "problem", message: "We couldn’t reach the server. Check your connection and try again.", verified: false });
    const limited = auth({ error: { status: 429 } });
    expect(await submitPassword(limited.client, "hash", "long enough", false)).toEqual({ kind: "problem", message: "Too many tries. Wait a while and try again.", verified: false });
  });

  it("remembers the spent token when the password is refused", async () => {
    const { client } = auth(ok, { error: { status: 422, code: "weak_password" } });
    expect(await submitPassword(client, "hash", "long enough", false)).toEqual({ kind: "problem", message: "Choose a stronger password.", verified: true });
  });

  it("reports an unreachable server after the token was spent", async () => {
    const { client } = auth(ok, { error: { status: 503 } });
    expect(await submitPassword(client, "hash", "long enough", false)).toEqual({ kind: "problem", message: "We couldn’t reach the server. Check your connection and try again.", verified: true });
  });
});


it("retains recovery type and workspace invitation", async () => {
  expect(parseInviteLink("?token_hash=h&type=recovery&invite=workspace", "#a%40b.co")).toEqual({ tokenHash: "h", email: "a@b.co", type: "recovery", invite: "workspace" });
  const { client, calls } = auth();
  await submitPassword(client, "h", "long enough", false, "recovery");
  expect(calls[0]).toEqual(["verify", { token_hash: "h", type: "recovery" }]);
});
it("asks for TOTP before updating the password and preserves the verified token", async () => {
  const { client, calls } = auth();
  client.mfa = {
    getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null }),
    listFactors: async () => ({ data: { totp: [{ id: "factor", status: "verified" }] }, error: null }),
  };
  expect(await submitPassword(client, "h", "long enough", false, "recovery")).toEqual({ kind: "mfa", factorId: "factor" });
  expect(calls).toHaveLength(1);
});
