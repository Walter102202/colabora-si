import { describe, expect, it } from "vitest";
import { demoReducer, demoReview, demoSignature, demoStatus, demoTimers, demoWorkReply, initialDemo, type DemoEvent, type DemoState } from "@/lib/landingDemo";

const play = (events: DemoEvent[], from: DemoState = initialDemo) => events.reduce(demoReducer, from);

// Runs every timer the state asks for until the clock has nothing left to do.
function letTimeRun(from: DemoState, reducedMotion = false): DemoState {
  let state = from;
  for (let guard = 0; guard < 20; guard += 1) {
    const timers = demoTimers(state.activity, reducedMotion);
    if (!timers.length) return state;
    state = play(timers.map((timer) => timer.event), state);
  }
  throw new Error("the demo clock never stops");
}

const atReview = () => play([{ type: "goto", step: 2 }]);

describe("the example", () => {
  it("starts at the brief with nothing accepted", () => {
    expect(demoStatus(initialDemo)).toEqual({ text: "Brief ready", tone: "brief" });
    expect(initialDemo.accepted).toBe(false);
  });

  it("drafts block by block after Do it and stops at ready for review", () => {
    let state = play([{ type: "start" }]);
    expect(state.step).toBe(0);
    state = play([{ type: "draft" }], state);
    expect([state.step, state.draftBlocks, demoStatus(state).text]).toEqual([1, 0, "Working"]);
    expect(demoSignature(state)).toBe("Trama · run 4abf5433 (running) · Just now");
    expect(demoWorkReply(state)).toBe("On it. I’ll add the draft to this page.");
    state = play([{ type: "block" }, { type: "block" }, { type: "block" }, { type: "block" }, { type: "drafted" }], state);
    expect([state.draftBlocks, state.activity, demoStatus(state).text]).toEqual([3, "idle", "Ready for review"]);
    expect(demoSignature(state)).toBe("Trama · run 4abf5433 (completed) · Just now");
  });

  it.each([false, true])("never accepts on a timer (reduced motion: %s)", (reducedMotion) => {
    const delivered = letTimeRun(play([{ type: "start" }]), reducedMotion);
    expect([delivered.step, delivered.activity, delivered.accepted]).toEqual([1, "idle", false]);
    const revised = letTimeRun(play([{ type: "goto", step: 2 }, { type: "send", text: "Shorter" }], delivered), reducedMotion);
    expect([revised.accepted, revised.version]).toEqual([false, 2]);
  });

  it("accepts on the click, in review only", () => {
    expect(play([{ type: "accept" }]).accepted).toBe(false);
    expect(play([{ type: "goto", step: 1 }, { type: "accept" }]).accepted).toBe(false);
    const state = play([{ type: "accept" }], atReview());
    expect(state.accepted).toBe(true);
    expect(demoStatus(state)).toEqual({ text: "Done · accepted", tone: "done" });
    expect(demoReview(state).reply).toBe("Version 1 is accepted. The task is closed.");
  });

  it("does not accept while the agent is revising", () => {
    const state = play([{ type: "send", text: "Shorter" }, { type: "accept" }], atReview());
    expect(state.accepted).toBe(false);
  });

  it("revises from a note and asks for review again", () => {
    const sent = play([{ type: "send", text: "  Shorter please  " }], atReview());
    expect([sent.note, demoStatus(sent).text, demoReview(sent).note]).toEqual(["Shorter please", "Working", "Trama has your feedback."]);
    const revised = play([{ type: "revised" }], sent);
    expect([revised.version, revised.note, demoStatus(revised).text]).toEqual([2, null, "Ready for review"]);
    expect(demoReview(revised).reply).toBe("Version 2 is on the page, ready for your review.");
    expect(demoSignature(revised)).toBe("Trama · run 9e20c1f7 (completed) · Just now");
  });

  it("ignores a blank note and a note after accepting", () => {
    expect(play([{ type: "send", text: "   " }], atReview()).activity).toBe("idle");
    expect(play([{ type: "accept" }, { type: "send", text: "Change it" }], atReview()).activity).toBe("idle");
  });

  it("shortens a long note", () => {
    const state = play([{ type: "send", text: "x".repeat(200) }], atReview());
    expect(state.note).toHaveLength(118);
    expect(state.note?.endsWith("…")).toBe(true);
  });

  it("lands a revision in progress when the visitor moves on", () => {
    const state = play([{ type: "send", text: "Shorter" }, { type: "goto", step: 1 }], atReview());
    expect([state.step, state.activity, state.version, state.note]).toEqual([1, "idle", 2, null]);
  });

  it("drops a pending start when the visitor jumps ahead", () => {
    const state = play([{ type: "start" }, { type: "goto", step: 2 }, { type: "draft" }]);
    expect([state.step, state.activity]).toEqual([2, "idle"]);
  });

  it("resets the decision when the visitor returns to the brief", () => {
    const state = play([{ type: "send", text: "Shorter" }, { type: "revised" }, { type: "accept" }, { type: "goto", step: 0 }], atReview());
    expect(state).toEqual(initialDemo);
  });

  it("keeps the signature's age while the visitor explores", () => {
    expect(demoSignature(play([{ type: "goto", step: 1 }]))).toBe("Trama · run 4abf5433 (completed) · 2m ago");
  });
});
