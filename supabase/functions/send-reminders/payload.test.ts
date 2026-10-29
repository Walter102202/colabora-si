import assert from "node:assert/strict";
import { agentPush, pushOutcome, shouldPush, tooOldToPush, type AgentNotification, type PushApproval } from "./payload.ts";

const n = (over: Partial<AgentNotification> = {}): AgentNotification => ({
  id: "n1", kind: "approval_requested", page_id: "row 1", task_id: "t1", approval_id: "ap1", block_id: null, payload: {}, ...over,
});
const action: PushApproval = { action: "send_email", params: { to: "team@example.com", subject: "Weekly" }, artifact_version: null, question: "Send it?", kind: "action", blocking: true, status: "pending" };
const question: PushApproval = { action: null, params: {}, artifact_version: null, question: "Which tone?", kind: "elicitation", blocking: false, status: "pending" };

Deno.test("an approval push says what the action does, never what the model wrote", () => {
  const p = agentPush(n({ payload: { summary: "I am about to send the email as planned" } }), "Weekly summary", action);
  assert.deepEqual(p, {
    id: "notification:n1", kind: "approval_requested", title: "Approval needed: Weekly summary",
    body: 'Send an email to team@example.com with subject "Weekly"', url: "/p/row%201?task=t1#approval-ap1",
  });
});

Deno.test("a question push says whether the agent keeps working", () => {
  const side = agentPush(n({ kind: "input_required" }), "Weekly summary", question);
  assert.equal(side.title, "Question (the agent keeps working): Weekly summary");
  assert.equal(side.body, "Which tone?");
  const blocking = agentPush(n({ kind: "input_required" }), "Weekly summary", { ...question, blocking: true });
  assert.equal(blocking.title, "Question: Weekly summary");
});

Deno.test("handover, review and failure pushes use fixed texts", () => {
  const texts = [
    agentPush(n({ kind: "input_required", approval_id: null, payload: { handover: true, note: "model text" } }), "Weekly summary", null),
    agentPush(n({ kind: "ready_for_review", approval_id: null }), "Weekly summary", null),
    agentPush(n({ kind: "task_failed", approval_id: null }), null, null),
  ].map((p) => [p.title, p.body, p.url]);
  assert.deepEqual(texts, [
    ["Handed over: Weekly summary", "The agent handed the task over. Open it to continue.", "/p/row%201?task=t1"],
    ["Ready for review: Weekly summary", "The agent delivered. Review it and close the task.", "/p/row%201?task=t1"],
    ["Task failed: a task", "The agent could not finish. Open the task to see why.", "/p/row%201?task=t1"],
  ]);
});

Deno.test("long titles and bodies are cut to 180 characters", () => {
  const p = agentPush(n(), "x".repeat(400), { ...action, params: { to: "y".repeat(400) } });
  assert.equal(p.title.length, 180);
  assert.equal(p.body.length, 180);
  assert.ok(p.body.endsWith("…"));
});

Deno.test("a decision already taken is not pushed", () => {
  assert.equal(shouldPush(n(), action), true);
  assert.equal(shouldPush(n(), { ...action, status: "decided" }), false);
  assert.equal(shouldPush(n({ kind: "input_required" }), { ...question, status: "cancelled" }), false);
  assert.equal(shouldPush(n({ kind: "ready_for_review", approval_id: null }), null), true);
  assert.equal(shouldPush(n(), null), true, "a failed lookup still sends the push, with a generic text");
});

Deno.test("the cut keeps whole characters and a push shows no control characters", () => {
  const p = agentPush(n({ kind: "input_required" }), "𝔘".repeat(200), { ...question, question: "Which" + String.fromCharCode(1, 10) + "tone?" });
  assert.equal(Array.from(p.title).length, 180);
  assert.ok(p.title.endsWith("𝔘…"));
  assert.equal(p.body, "Which  tone?");
});

Deno.test("a link too long for a push opens the home page", () => {
  assert.equal(agentPush(n({ page_id: "😀".repeat(200) }), "Weekly summary", action).url, "/");
  assert.equal(agentPush(n({ page_id: "😀".repeat(20) }), "Weekly summary", action).url.startsWith("/p/"), true);
});

Deno.test("a push leaves the queue when delivered or refused for good, and is tried again otherwise", () => {
  assert.equal(pushOutcome([201]), "delivered");
  assert.equal(pushOutcome([400, 201]), "delivered");
  assert.equal(pushOutcome([400]), "drop");
  assert.equal(pushOutcome([403, 410, 413]), "drop");
  assert.equal(pushOutcome([429]), "retry");
  assert.equal(pushOutcome([503]), "retry");
  assert.equal(pushOutcome(["threw"]), "retry");
  assert.equal(pushOutcome([400, "threw"]), "retry");
  assert.equal(pushOutcome([]), "retry", "no subscription was tried in this pass");
});

Deno.test("a notification older than the push TTL is not pushed any more", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(tooOldToPush("2026-10-29T12:30:00Z", now), false);
  assert.equal(tooOldToPush("2026-10-29T11:30:00Z", now), true);
});
