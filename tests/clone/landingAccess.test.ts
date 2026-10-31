import { describe, expect, it } from "vitest";
import { emailProblem, joinWaitlist, LOGIN_MISMATCH, LOGIN_UNREACHABLE, loginProblem, TOO_MANY_TRIES } from "@/lib/landingAccess";

const answering = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;

describe("emailProblem", () => {
  it("accepts an address and asks for a missing or malformed one", () => {
    expect(emailProblem(" ana@company.co ")).toBe("");
    expect(emailProblem("  ")).toBe("Enter your email so we can send your invite.");
    expect(emailProblem("ana@company")).toBe("Check your email. It should look like name@company.com.");
    expect(emailProblem("ana company@x.co")).not.toBe("");
  });
});

describe("joinWaitlist", () => {
  it("posts the trimmed email and the honeypot to the function", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const send = (async (to: string, options: RequestInit) => { url = to; init = options; return new Response("{}"); }) as typeof fetch;
    expect(await joinWaitlist("https://x.supabase.co/", " ana@company.co ", "", send)).toBe("joined");
    expect(url).toBe("https://x.supabase.co/functions/v1/waitlist");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "ana@company.co", company: "" });
  });

  it("reports a rate limit apart from a failure", async () => {
    expect(await joinWaitlist("https://x.co", "a@b.co", "", answering(429))).toBe("rate_limited");
    expect(await joinWaitlist("https://x.co", "a@b.co", "", answering(500))).toBe("failed");
  });

  it("fails without a network or without a backend", async () => {
    const down = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    expect(await joinWaitlist("https://x.co", "a@b.co", "", down)).toBe("failed");
    expect(await joinWaitlist(undefined, "a@b.co", "", answering(200))).toBe("failed");
  });
});

describe("loginProblem", () => {
  it("never tells which of the two fields was wrong", () => {
    expect(loginProblem({ name: "AuthApiError", status: 400 })).toBe(LOGIN_MISMATCH);
    expect(loginProblem({ name: "AuthApiError", status: 422 })).toBe(LOGIN_MISMATCH);
  });

  it("says plainly when the server cannot be reached", () => {
    expect(loginProblem({ name: "AuthRetryableFetchError", status: 0 })).toBe(LOGIN_UNREACHABLE);
    expect(loginProblem({ name: "AuthRetryableFetchError", status: 503 })).toBe(LOGIN_UNREACHABLE);
    expect(loginProblem({ name: "TypeError" })).toBe(LOGIN_UNREACHABLE);
  });

  it("asks to wait on a rate limit", () => {
    expect(loginProblem({ name: "AuthApiError", status: 429 })).toBe(TOO_MANY_TRIES);
  });
});
