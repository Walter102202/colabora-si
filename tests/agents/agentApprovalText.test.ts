import { describe, expect, it } from "vitest";
import { describeApproval, KNOWN_ACTIONS, summarizeParams } from "@/lib/agentApprovalText";

describe("describeApproval", () => {
  it("send_email names the recipient and the subject", () => {
    expect(describeApproval("send_email", { to: "ops@example.com", subject: "Leads cleanup done" })).toEqual({
      what: 'Send an email to ops@example.com with subject "Leads cleanup done"',
      effect: "The email leaves the workspace and cannot be recalled.",
    });
    expect(describeApproval("send_email", { to: ["a@x.test", "b@x.test"] }).what).toBe("Send an email to a@x.test, b@x.test");
    expect(describeApproval("send_email", {}).what).toBe("Send an email to (recipient missing)");
  });
  it("publish_page names the page", () => {
    expect(describeApproval("publish_page", { page_id: "launch-plan" })).toEqual({
      what: "Publish page launch-plan",
      effect: "Anyone with the link can read it until it is unpublished.",
    });
  });
  it("publish_page requires the canonical page_id", () => {
    expect(describeApproval("publish_page", { ref: "other", page: "other" }).what).toBe("Publish page (page missing)");
  });
  it("http_request names method and URL", () => {
    expect(describeApproval("http_request", { url: "https://api.example.com/v1/send" }).what).toBe("Call POST https://api.example.com/v1/send");
    expect(describeApproval("http_request", { method: "delete", url: "https://api.example.com/x" }).what).toBe("Call DELETE https://api.example.com/x");
    expect(describeApproval("http_request", {}).effect).toBe("The request runs once against an external service.");
  });
  it("payment names amount, currency and payee", () => {
    expect(describeApproval("payment", { amount: 120, currency: "EUR", to: "Acme" })).toEqual({
      what: "Pay 120 EUR to Acme",
      effect: "Money moves and cannot be reversed from here.",
    });
  });
  it("any other action is shown verbatim with a flat summary of its parameters", () => {
    expect(describeApproval("rotate_keys", { account: "prod", force: true, tags: ["a", "b"] })).toEqual({
      what: "Run rotate_keys with account: prod, force: true, tags: (2 items)",
      effect: "Runs exactly once outside the workspace and cannot be undone from here.",
    });
    expect(describeApproval(null, {}).what).toBe("Run the requested action");
  });
  it("mentions the deliverable version when there is one", () => {
    expect(describeApproval("send_email", { to: "x@y.test" }, { artifactVersion: 2 }).what).toBe("Send an email to x@y.test for deliverable v2");
  });
  it("is deterministic and bounded", () => {
    const params = { a: "x".repeat(500), b: 1, c: 2, d: 3, e: 4, f: 5 };
    const once = summarizeParams(params);
    expect(summarizeParams(params)).toBe(once);
    expect(once.length).toBeLessThanOrEqual(120);
    expect(once.split(", ").length).toBeLessThanOrEqual(4);
  });
  it("exports the known vocabulary", () => {
    expect([...KNOWN_ACTIONS]).toEqual(["send_email", "publish_page", "http_request", "payment"]);
  });
});
