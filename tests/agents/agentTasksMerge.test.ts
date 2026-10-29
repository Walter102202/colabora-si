import { describe, expect, it } from "vitest";
import { mergeActivities, mergeRows, type ActivityRow } from "@/lib/agentTasks";

// The task store pages its tables: every page merges into the map it already has.
const act = (id: string, seq: number): ActivityRow => ({ id, task_id: "t1", run_id: null, seq, type: "thought", body: {}, ephemeral: false, author_type: "agent", author_id: "a", created_at: "2026-10-29T00:00:00Z" });

describe("mergeRows", () => {
  it("keeps rows that are not in the new page and overwrites the ones that are", () => {
    const merged = mergeRows({ a: { id: "a", v: 1 }, b: { id: "b", v: 1 } }, [{ id: "b", v: 2 }, { id: "c", v: 1 }]);
    expect(merged).toEqual({ a: { id: "a", v: 1 }, b: { id: "b", v: 2 }, c: { id: "c", v: 1 } });
  });
  it("returns a new object and tolerates null", () => {
    const cur = { a: { id: "a" } };
    expect(mergeRows(cur, null)).not.toBe(cur);
    expect(mergeRows(cur, null)).toEqual(cur);
  });
});

describe("mergeActivities", () => {
  it("dedupes by id and sorts by seq", () => {
    expect(mergeActivities([act("x", 3), act("y", 1)], [act("x", 3), act("z", 2)]).map((a) => a.seq)).toEqual([1, 2, 3]);
  });
  it("starts from nothing", () => {
    expect(mergeActivities(undefined, [act("y", 1)]).map((a) => a.id)).toEqual(["y"]);
  });
});
