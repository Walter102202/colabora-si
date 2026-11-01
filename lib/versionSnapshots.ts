import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { isApplyingExternal } from "@/lib/externalApply";
import { foreignPageIds } from "@/lib/foreignPages";
import { isShell } from "@/lib/pageShell";
import { pauseHistory, resumeHistory } from "@/lib/history";

export const SNAPSHOT_IDLE_MS = 30_000;
export interface SnapshotClock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
const defaultClock: SnapshotClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export class IdleSnapshotTimer {
  private dirty = false;
  private lastEdit = 0;
  private timer: unknown;
  constructor(private snapshot: () => void, private idleMs = SNAPSHOT_IDLE_MS, private clock: SnapshotClock = defaultClock) {}
  edited(): void { this.dirty = true; this.lastEdit = this.clock.now(); this.arm(this.idleMs); }
  private arm(ms: number): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      const remaining = this.idleMs - (this.clock.now() - this.lastEdit);
      if (remaining > 0) this.arm(remaining);
      else { this.snapshot(); this.dirty = false; }
    }, ms);
  }
  dispose(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) { this.snapshot(); this.dirty = false; }
  }
}
export function useIdleSnapshot(pageId: string): void {
  useEffect(() => {
    if (foreignPageIds.has(pageId)) return;
    const timer = new IdleSnapshotTimer(() => {
      const state = useStore.getState();
      if (!state.pages[pageId] || isShell(state.pages[pageId])) return;
      // Automatic versions are saved and synced without consuming a user's undo step.
      pauseHistory();
      try { state.saveVersion(pageId, true); } finally { resumeHistory(); }
    });
    const unsubscribe = useStore.subscribe((state, prev) => {
      if (isApplyingExternal() || foreignPageIds.has(pageId)) return;
      const a = state.pages[pageId], b = prev.pages[pageId];
      if (isShell(a) !== isShell(b)) return;
      if (a && b && a !== b && (a.blocks !== b.blocks || a.title !== b.title || a.database !== b.database)) timer.edited();
    });
    return () => { unsubscribe(); timer.dispose(); };
  }, [pageId]);
}
