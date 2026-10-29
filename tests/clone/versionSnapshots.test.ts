import { expect, it, vi } from "vitest";
import { IdleSnapshotTimer, type SnapshotClock } from "@/lib/versionSnapshots";

function setup() {
  let now = 0, nextId = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const clock: SnapshotClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++nextId; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { pending.delete(id as number); },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; pending.delete(next[0]); next[1].fn();
    }
    now = target;
  };
  const snapshot = vi.fn(), timer = new IdleSnapshotTimer(snapshot, undefined, clock);
  return { timer, snapshot, advance };
}
it("VT-1 no edit, no snapshot", () => { const s = setup(); s.advance(120_000); expect(s.snapshot).not.toHaveBeenCalled(); });
it("VT-2 one edit then 30 s idle → one snapshot", () => {
  const s = setup(); s.timer.edited(); s.advance(29_999); expect(s.snapshot).not.toHaveBeenCalled(); s.advance(1); expect(s.snapshot).toHaveBeenCalledTimes(1);
});
it("VT-3 edits every 10 s postpone the snapshot", () => {
  const s = setup(); for (let i = 0; i < 6; i++) { s.timer.edited(); s.advance(10_000); }
  expect(s.snapshot).not.toHaveBeenCalled(); s.advance(20_000); expect(s.snapshot).toHaveBeenCalledTimes(1);
});
it("VT-4 dispose with pending changes snapshots once", () => {
  const s = setup(); s.timer.edited(); s.timer.dispose(); expect(s.snapshot).toHaveBeenCalledTimes(1); s.advance(60_000); expect(s.snapshot).toHaveBeenCalledTimes(1);
});
it("VT-5 dispose without changes does nothing", () => { const s = setup(); s.timer.dispose(); expect(s.snapshot).not.toHaveBeenCalled(); });
