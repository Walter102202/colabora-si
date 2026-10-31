import { describe, expect, it } from "vitest";
import { chooseEntry, hasStoredSession, type EntryInput } from "@/lib/landingEntry";

const visitor: EntryInput = { pathname: "/", search: "", hash: "", hasBackend: true, hasSession: false };

function storage(items: Record<string, string>) {
  const keys = Object.keys(items);
  return { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (key: string) => items[key] ?? null };
}

describe("chooseEntry", () => {
  it("shows the landing to a signed-out visitor at /", () => {
    expect(chooseEntry(visitor)).toBe("landing");
  });

  it("keeps the workspace at / with a session", () => {
    expect(chooseEntry({ ...visitor, hasSession: true })).toBe("workspace");
  });

  it("keeps the workspace at / on a build without a backend", () => {
    expect(chooseEntry({ ...visitor, hasBackend: false })).toBe("workspace");
  });

  it.each(["invite=abc", "settings=agents", "search=notes", "peek=page", "modal=auth", "code=pkce", "token_hash=t", "error=access_denied"])(
    "lets the app handle ?%s", (query) => {
      expect(chooseEntry({ ...visitor, search: `?${query}` })).toBe("workspace");
    },
  );

  it.each(["#access_token=t&type=recovery", "#error=access_denied&error_code=otp_expired"])("lets the app handle the auth callback %s", (hash) => {
    expect(chooseEntry({ ...visitor, hash })).toBe("workspace");
  });

  it("stays on the landing for campaign parameters and page anchors", () => {
    expect(chooseEntry({ ...visitor, search: "?utm_source=x&utm_campaign=beta" })).toBe("landing");
    expect(chooseEntry({ ...visitor, hash: "#cs-join" })).toBe("landing");
  });

  it("always shows the landing at /landing", () => {
    expect(chooseEntry({ ...visitor, pathname: "/landing", hasBackend: false })).toBe("landing");
    expect(chooseEntry({ ...visitor, pathname: "/landing/", hasSession: true })).toBe("landing");
  });

  it.each(["/p/abc", "/shared/abc", "/pub/abc", "/linked", "/mcp-pat", "/oauth/consent", "/nowhere"])("leaves %s to the app", (pathname) => {
    expect(chooseEntry({ ...visitor, pathname })).toBe("workspace");
  });
});

describe("hasStoredSession", () => {
  it("finds a supabase session", () => {
    expect(hasStoredSession(storage({ "colabora-theme": "dark", "sb-abc123-auth-token": "{}" }))).toBe(true);
  });

  it("ignores other keys and an empty value", () => {
    expect(hasStoredSession(storage({ "colabora-theme": "dark", "sb-abc123-auth-token-code-verifier": "x", "sb-abc123-auth-token": "" }))).toBe(false);
  });

  it("treats blocked storage as signed out", () => {
    const blocked = { length: 1, key: () => { throw new Error("denied"); }, getItem: () => null };
    expect(hasStoredSession(blocked)).toBe(false);
  });
});
