import { applyRemotePatch, useStore, type RemotePatch } from "@/lib/store";
import type { WorkspaceState } from "@/lib/types";

type Snapshot = Pick<WorkspaceState, "pages" | "rootOrder" | "syncedBlocks">;
const past: Snapshot[] = [];
const future: Snapshot[] = [];
let isTimeTraveling = false;
let pauseDepth = 0;
let burstTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let prev: Snapshot;
const snapshot = (): Snapshot => {
  const { pages, rootOrder, syncedBlocks } = useStore.getState();
  return { pages, rootOrder, syncedBlocks };
};
function flushBurst() {
  if (burstTimer !== null) clearTimeout(burstTimer);
  burstTimer = null;
}
export function pushHistory(value: Snapshot): void {
  past.push(value);
  if (past.length > 200) past.shift();
  future.length = 0;
}
export function initHistory(): void {
  if (started) return;
  started = true;
  prev = snapshot();
  past.length = 0;
  future.length = 0;
  useStore.subscribe(() => {
    const current = snapshot();
    if (isTimeTraveling || pauseDepth > 0) { prev = current; return; }
    if (current.pages === prev.pages && current.rootOrder === prev.rootOrder && current.syncedBlocks === prev.syncedBlocks) return;
    if (burstTimer === null) pushHistory(prev);
    flushBurst();
    burstTimer = setTimeout(() => { burstTimer = null; }, 350);
    prev = current;
  });
}
function travel(from: Snapshot[], to: Snapshot[]) {
  if (!from.length) return;
  flushBurst();
  to.push(snapshot());
  const target = from.pop()!;
  isTimeTraveling = true;
  try {
    if (typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      if (active?.isContentEditable || active?.tagName === "TEXTAREA") active.blur();
    }
    useStore.setState(target);
  } finally { isTimeTraveling = false; }
}
export function undo(): void { travel(past, future); }
export function redo(): void { travel(future, past); }
export function canUndo(): boolean { return past.length > 0; }
export function canRedo(): boolean { return future.length > 0; }
export function pauseHistory(): void { pauseDepth++; }
export function resumeHistory(): void { pauseDepth = Math.max(0, pauseDepth - 1); }
export function rebaseHistory(patch: RemotePatch): void {
  if (!Object.keys(patch.pages ?? {}).length && !patch.rootOrder && !patch.syncedBlocks) return;
  for (const stack of [past, future]) {
    for (let i = 0; i < stack.length; i++) stack[i] = { ...stack[i], ...applyRemotePatch(stack[i], patch) };
  }
}
