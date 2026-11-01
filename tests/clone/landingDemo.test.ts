import { describe, expect, it } from "vitest";
import { DEMO_END, DEMO_STEPS, demoBlocks, demoDelay, demoNote, demoOutcome, demoReducer, demoStart, demoStatus, demoStep, type DemoEvent, type DemoState } from "@/lib/landingDemo";

const play = (events: DemoEvent[], from: DemoState = demoStart(false)) => events.reduce(demoReducer, from);
const at = (beat: number) => play([{ type: "goto", beat }]);
const atCard = () => at(DEMO_END);
const titles = (state: DemoState) => demoBlocks(state).map((block) => block.title);

// Lets the clock run until it stops on its own or comes back to the first beat.
function letTimeRun(from: DemoState): { state: DemoState; spent: number } {
  let state = from;
  let spent = 0;
  for (let guard = 0; guard < 40; guard += 1) {
    const delay = demoDelay(state);
    if (delay === null) return { state, spent };
    spent += delay;
    state = demoReducer(state, { type: "tick" });
    if (state.beat === 0) return { state, spent };
  }
  throw new Error("the demo clock never stops");
}

describe("the clock", () => {
  it("shows Claude Code half a second longer than the work around it", () => {
    expect(Array.from({ length: DEMO_END }, (_, beat) => demoDelay(at(beat)))).toEqual([1200, 900, 1000, 1900, 1100, 1900, 1100, 1800, 1700]);
  });

  it("replays 5 s after the card appears when nobody decides", () => {
    expect(demoDelay(atCard())).toBe(5000);
    expect(demoReducer(atCard(), { type: "tick" }).beat).toBe(0);
  });

  it("replays 3 s after a decision", () => {
    const decided = play([{ type: "choose", choice: "approved" }], atCard());
    expect(demoDelay(decided)).toBe(3000);
    expect(demoReducer(decided, { type: "tick" })).toEqual(demoStart(false));
  });

  it("runs a whole round in 17.6 s and never decides on its own", () => {
    const { state, spent } = letTimeRun(demoStart(false));
    expect(spent).toBe(17600);
    expect(state).toEqual(demoStart(false));
  });

  it.each([{ pointer: true }, { focused: true }])("keeps an undecided card while a hand is on it: %j", (hand) => {
    const held = play([{ type: "hand", ...hand }], atCard());
    expect(demoDelay(held)).toBeNull();
    expect(demoReducer(held, { type: "tick" })).toBe(held);
  });

  it("gives a full 5 s again when the hand leaves", () => {
    const left = play([{ type: "hand", pointer: true }, { type: "hand", pointer: false }], atCard());
    expect(demoDelay(left)).toBe(5000);
  });

  it("does not stop the work for a hand on the window", () => {
    expect(demoDelay(play([{ type: "hand", pointer: true }], at(3)))).toBe(1900);
  });

  it("replays after a decision even with a hand on the window", () => {
    expect(demoDelay(play([{ type: "hand", pointer: true }, { type: "hand", focused: true }, { type: "choose", choice: "rejected" }], atCard()))).toBe(3000);
  });

  it("forgets keyboard focus when the clock starts over, because the focused element is gone", () => {
    const decided = play([{ type: "hand", focused: true, pointer: true }, { type: "choose", choice: "approved" }], atCard());
    expect(demoReducer(decided, { type: "tick" })).toMatchObject({ focused: false, pointer: true });
  });

  it("keeps keyboard focus on a step, which is still there after the jump", () => {
    expect(play([{ type: "hand", focused: true }, { type: "goto", beat: DEMO_END }])).toMatchObject({ focused: true });
  });
});

describe("the decision", () => {
  it("only exists on the card", () => {
    expect(play([{ type: "choose", choice: "approved" }], at(8)).choice).toBeNull();
    expect(play([{ type: "choose", choice: "approved" }, { type: "choose", choice: "rejected" }], atCard()).choice).toBe("approved");
  });

  it("says what approving did", () => {
    const state = play([{ type: "choose", choice: "approved" }], atCard());
    expect(demoStatus(state)).toEqual({ text: "Done", tone: "done" });
    expect(demoOutcome("approved")).toEqual({ title: "Approved by you.", text: "Codex merged pull request #128." });
    expect(demoNote(state)).toBe("Fixed by Codex · Reviewed by Claude Code · Approved by you");
  });

  it("says what rejecting did", () => {
    const state = play([{ type: "choose", choice: "rejected" }], atCard());
    expect(demoStatus(state)).toEqual({ text: "Working", tone: "working" });
    expect(demoOutcome("rejected")).toEqual({ title: "Rejected by you.", text: "Nothing was merged." });
    expect(demoNote(state)).toBe("Fixed by Codex · Reviewed by Claude Code");
  });
});

describe("the task", () => {
  it("starts from the goal alone", () => {
    expect(titles(demoStart(false))).toEqual(["Goal"]);
  });

  it("adds what broke, then the fix, then the Lead's approval", () => {
    expect(titles(at(1))).toEqual(["Goal", "What broke"]);
    expect(titles(at(2))).toEqual(["Goal", "What broke", "The fix"]);
    expect(titles(at(6))).toEqual(["Goal", "What broke", "The fix"]);
    expect(titles(at(7))).toEqual(["Goal", "What broke", "The fix", "Approved · by Claude Code · deliverable v3 · brief v1"]);
  });

  it("shows two requests from Claude Code to Codex, each answered in a new run", () => {
    const fix = (beat: number) => demoBlocks(at(beat))[2];
    expect(fix(2)).toMatchObject({ text: "Trim the address before saving it.", sign: "Codex · run 4abf5433 (running) · Just now" });
    expect(fix(2).ask).toBeUndefined();
    expect(fix(3)).toMatchObject({ ask: "Claude Code: Add a test for this case.", sign: "Codex · run 4abf5433 (completed) · Just now" });
    expect(fix(4)).toMatchObject({ text: "Trim the address before saving it. Test added.", sign: "Codex · run 9e20c1f7 (running) · Just now" });
    expect(fix(4).ask).toBeUndefined();
    expect(fix(5)).toMatchObject({ ask: "Claude Code: Apply it to login too.", sign: "Codex · run 9e20c1f7 (completed) · Just now" });
    expect(fix(6)).toMatchObject({ text: "Trim the address in signup and login before saving it. Test added.", sign: "Codex · run c71d0a32 (running) · Just now" });
    expect(fix(7).sign).toBe("Codex · run c71d0a32 (completed) · Just now");
  });

  it("records the Lead's approval with its evidence", () => {
    expect(demoBlocks(at(7))[3]).toMatchObject({ by: "Claude Code", checks: [{ text: "Signup and login accept a trailing space", tag: "verified" }, { text: "Tests pass", tag: "CI passed" }] });
  });

  it("marks only agent blocks with their author", () => {
    expect(demoBlocks(at(7)).map((block) => block.by)).toEqual([undefined, "Codex", "Codex", "Claude Code"]);
  });

  it.each([
    [0, "Working", "working"], [2, "Working", "working"],
    [3, "Lead reviewing · round 1 of 2", "review"], [4, "Working · round 1 of 2", "working"],
    [5, "Lead reviewing · round 2 of 2", "review"], [6, "Working · round 2 of 2", "working"],
    [7, "Approved · by Claude Code", "review"], [8, "Needs your decision", "decision"], [9, "Needs your decision", "decision"],
  ])("states beat %i as %s", (beat, text, tone) => {
    expect(demoStatus(at(beat))).toEqual({ text, tone });
  });
});

describe("the stepper", () => {
  it("follows the clock", () => {
    expect([0, 1, 7, 8, DEMO_END].map((beat) => demoStep(beat))).toEqual([0, 1, 1, 2, 2]);
  });

  it("jumps to the start of each part and clears a decision", () => {
    const decided = play([{ type: "choose", choice: "approved" }], atCard());
    expect(DEMO_STEPS.map((step) => play([{ type: "goto", beat: step.beat }], decided)).map(({ beat, choice }) => [beat, choice])).toEqual([[0, null], [1, null], [8, null]]);
  });
});

describe("without motion", () => {
  it("opens on the decision", () => {
    expect(demoStart(true).beat).toBe(DEMO_END);
    expect(demoStatus(demoStart(true)).text).toBe("Needs your decision");
  });

  it("gives each step a finished picture", () => {
    expect(DEMO_STEPS.map((step) => step.still)).toEqual([0, 7, DEMO_END]);
    expect(demoBlocks(at(DEMO_STEPS[1].still)).every((block) => !block.sign?.includes("running"))).toBe(true);
  });
});
