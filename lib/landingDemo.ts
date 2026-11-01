// The landing's example: Claude Code leads, Codex works, and Trama brings the last call to the visitor.
// Local state only: it runs no agent and calls no backend, and only the visitor's click decides.
export type DemoChoice = "approved" | "rejected";
export type DemoTone = "working" | "review" | "decision" | "done";

// How long each beat stays on screen, then the card with the decision.
const BEATS = [1200, 900, 1000, 1900, 1100, 1900, 1100, 1800, 1700];
const CARD_WAIT = 5000;
const DECIDED_WAIT = 3000;
const ALL_WORK_DONE = 7;

export const DEMO_CALL = 8;
export const DEMO_END = BEATS.length;
// `still` is where a step lands when nothing moves on its own.
export const DEMO_STEPS = [
  { label: "1 · Brief", beat: 0, still: 0 },
  { label: "2 · Work", beat: 1, still: ALL_WORK_DONE },
  { label: "3 · Review", beat: DEMO_CALL, still: DEMO_END },
];

export interface DemoState {
  beat: number;
  choice: DemoChoice | null;
  pointer: boolean;
  focused: boolean;
}

export type DemoEvent =
  | { type: "tick" }
  | { type: "goto"; beat: number }
  | { type: "choose"; choice: DemoChoice }
  | { type: "hand"; pointer?: boolean; focused?: boolean };

export interface DemoCheck { text: string; tag: string }

export interface DemoBlock {
  title: string;
  text?: string;
  by?: string;
  sign?: string;
  ask?: string;
  checks?: DemoCheck[];
}

export function demoStart(reducedMotion: boolean): DemoState {
  return { beat: reducedMotion ? DEMO_END : 0, choice: null, pointer: false, focused: false };
}

export function demoReducer(state: DemoState, event: DemoEvent): DemoState {
  switch (event.type) {
    case "tick":
      if (demoDelay(state) === null) return state;
      // The focused element goes away with the old round, and it leaves without a blur event.
      return state.choice || state.beat === DEMO_END ? { ...state, beat: 0, choice: null, focused: false } : { ...state, beat: state.beat + 1 };
    case "goto":
      return { ...state, beat: event.beat, choice: null };
    case "choose":
      return state.beat === DEMO_END && !state.choice ? { ...state, choice: event.choice } : state;
    case "hand":
      return { ...state, pointer: event.pointer ?? state.pointer, focused: event.focused ?? state.focused };
  }
}

// What the clock waits for next. It only moves the agents' work and starts over: null means it waits for the visitor.
export function demoDelay({ beat, choice, pointer, focused }: DemoState): number | null {
  if (choice) return DECIDED_WAIT;
  if (beat < DEMO_END) return BEATS[beat];
  return pointer || focused ? null : CARD_WAIT;
}

export function demoStep(beat: number): number {
  return DEMO_STEPS.filter((step) => beat >= step.beat).length - 1;
}

export function demoStatus({ beat, choice }: DemoState): { text: string; tone: DemoTone } {
  if (beat <= 2) return { text: "Working", tone: "working" };
  if (beat === 3) return { text: "Lead reviewing · round 1 of 2", tone: "review" };
  if (beat === 4) return { text: "Working · round 1 of 2", tone: "working" };
  if (beat === 5) return { text: "Lead reviewing · round 2 of 2", tone: "review" };
  if (beat === 6) return { text: "Working · round 2 of 2", tone: "working" };
  if (beat === ALL_WORK_DONE) return { text: "Approved · by Claude Code", tone: "review" };
  if (choice === "approved") return { text: "Done", tone: "done" };
  return choice === "rejected" ? { text: "Working", tone: "working" } : { text: "Needs your decision", tone: "decision" };
}

const signature = (run: string, running: boolean) => `Codex · run ${run} (${running ? "running" : "completed"}) · Just now`;

function fixBlock(beat: number): DemoBlock {
  const block = { title: "The fix", by: "Codex" };
  if (beat === 2) return { ...block, text: "Trim the address before saving it.", sign: signature("4abf5433", true) };
  if (beat === 3) return { ...block, text: "Trim the address before saving it.", sign: signature("4abf5433", false), ask: "Claude Code: Add a test for this case." };
  if (beat === 4) return { ...block, text: "Trim the address before saving it. Test added.", sign: signature("9e20c1f7", true) };
  if (beat === 5) return { ...block, text: "Trim the address before saving it. Test added.", sign: signature("9e20c1f7", false), ask: "Claude Code: Apply it to login too." };
  return { ...block, text: "Trim the address in signup and login before saving it. Test added.", sign: signature("c71d0a32", beat === 6) };
}

export function demoBlocks({ beat }: DemoState): DemoBlock[] {
  const blocks: DemoBlock[] = [{ title: "Goal", text: "People can join the waitlist from any phone." }];
  if (beat >= 1) blocks.push({ title: "What broke", text: "Signup fails when an email ends in a space.", by: "Codex", sign: signature("4abf5433", beat <= 2) });
  if (beat >= 2) blocks.push(fixBlock(beat));
  if (beat >= ALL_WORK_DONE) blocks.push({ title: "Approved · by Claude Code · deliverable v3 · brief v1", by: "Claude Code", checks: [{ text: "Signup and login accept a trailing space", tag: "verified" }, { text: "Tests pass", tag: "CI passed" }] });
  return blocks;
}

export function demoNote({ choice }: DemoState): string {
  return `Fixed by Codex · Reviewed by Claude Code${choice === "approved" ? " · Approved by you" : ""}`;
}

export function demoOutcome(choice: DemoChoice): { title: string; text: string } {
  return choice === "approved"
    ? { title: "Approved by you.", text: "Codex merged pull request #128." }
    : { title: "Rejected by you.", text: "Nothing was merged." };
}
