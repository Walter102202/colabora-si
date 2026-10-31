// The landing's example: one brief goes Brief, Work, Review. Local state only: it runs no agent
// and calls no backend, and only the visitor's click accepts anything.
export type DemoStep = 0 | 1 | 2;
export type DemoActivity = "idle" | "starting" | "drafting" | "revising";
export type DemoTone = "brief" | "working" | "review" | "done";

export const DRAFT_BLOCKS = 3;
const NOTE_LIMIT = 120;

export interface DemoState {
  step: DemoStep;
  activity: DemoActivity;
  draftBlocks: number;
  accepted: boolean;
  version: number;
  justNow: boolean;
  note: string | null;
}

export type DemoEvent =
  | { type: "goto"; step: DemoStep }
  | { type: "start" }
  | { type: "draft" }
  | { type: "block" }
  | { type: "drafted" }
  | { type: "accept" }
  | { type: "send"; text: string }
  | { type: "revised" };

export interface DemoTimer { after: number; event: DemoEvent }

export const initialDemo: DemoState = { step: 0, activity: "idle", draftBlocks: DRAFT_BLOCKS, accepted: false, version: 1, justNow: false, note: null };

export function demoReducer(state: DemoState, event: DemoEvent): DemoState {
  switch (event.type) {
    case "goto": {
      if (event.step === 0) return initialDemo;
      const revising = state.activity === "revising";
      return { ...state, step: event.step, activity: "idle", draftBlocks: DRAFT_BLOCKS, note: null, justNow: revising, version: state.version + (revising ? 1 : 0) };
    }
    case "start":
      return state.step === 0 && state.activity === "idle" ? { ...state, activity: "starting" } : state;
    case "draft":
      return state.activity === "starting" ? { ...state, step: 1, activity: "drafting", draftBlocks: 0, justNow: true } : state;
    case "block":
      return state.activity === "drafting" ? { ...state, draftBlocks: Math.min(state.draftBlocks + 1, DRAFT_BLOCKS) } : state;
    case "drafted":
      return state.activity === "drafting" ? { ...state, activity: "idle", draftBlocks: DRAFT_BLOCKS } : state;
    case "accept":
      return state.step === 2 && state.activity === "idle" ? { ...state, accepted: true } : state;
    case "send": {
      const text = event.text.trim();
      if (!text || state.step !== 2 || state.activity !== "idle" || state.accepted) return state;
      return { ...state, activity: "revising", note: text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT - 3)}…` : text };
    }
    case "revised":
      return state.activity === "revising" ? { ...state, activity: "idle", version: state.version + 1, justNow: true, note: null } : state;
  }
}

// What the clock may do next. None of these events accepts anything.
export function demoTimers(activity: DemoActivity, reducedMotion: boolean): DemoTimer[] {
  const after = (ms: number) => (reducedMotion ? 0 : ms);
  if (activity === "starting") return [{ after: after(550), event: { type: "draft" } }];
  if (activity === "revising") return [{ after: after(1500), event: { type: "revised" } }];
  if (activity !== "drafting") return [];
  if (reducedMotion) return [{ after: 0, event: { type: "drafted" } }];
  return [
    ...[200, 650, 1100].map((ms) => ({ after: ms, event: { type: "block" } as const })),
    { after: 1600, event: { type: "drafted" } },
  ];
}

export function demoStatus({ step, activity, accepted }: DemoState): { text: string; tone: DemoTone } {
  if (step === 0) return { text: "Brief ready", tone: "brief" };
  if (activity === "drafting" || activity === "revising") return { text: "Working", tone: "working" };
  return accepted ? { text: "Done · accepted", tone: "done" } : { text: "Ready for review", tone: "review" };
}

export function demoSignature({ activity, version, justNow }: DemoState): string {
  const run = version > 1 ? "9e20c1f7" : "4abf5433";
  if (activity === "drafting") return `Trama · run ${run} (running) · Just now`;
  return `Trama · run ${run} (completed) · ${justNow ? "Just now" : "2m ago"}`;
}

export function demoWorkReply({ activity }: DemoState): string {
  if (activity === "drafting") return "On it. I’ll add the draft to this page.";
  return "The draft is ready. The audience, message and checklist are in the page, next to your original brief.";
}

export function demoReview({ activity, accepted, version }: DemoState) {
  const revising = activity === "revising";
  if (accepted) {
    return {
      title: "Launch brief · accepted",
      reply: `Version ${version} is accepted. The task is closed.`,
      note: "Accepted by you · The draft is kept with the task.",
      caption: "Prepared by Trama · Accepted by you",
    };
  }
  return {
    title: "Launch brief · ready for review",
    reply: revising ? "Got it. I’ll update the draft on this page."
      : version > 1 ? `Version ${version} is on the page, ready for your review.`
        : "Review the brief and checklist. You can accept the draft or ask for changes.",
    note: revising ? "Trama has your feedback." : "Your review: is this draft ready to keep?",
    caption: revising ? "Prepared by Trama · Your note is with Trama" : "Prepared by Trama · Awaiting your acceptance",
  };
}
