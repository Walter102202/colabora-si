import { describe, expect, it } from "vitest";
import { isRunActive, itemLabel, revertableKeys, statusLabel, wordDiff, type DiffItem, type DiffStatus, type RunDiff } from "@/lib/agentRunDiff";

describe("run diff", () => {
  it("wordDiff marks inserted and deleted words", () => {
    expect(wordDiff("Hello A", "Hello from the agent")).toEqual([
      { op: "same", text: "Hello" }, { op: "del", text: "A" }, { op: "add", text: "from the agent" },
    ]);
    expect(wordDiff("same", "same")).toEqual([{ op: "same", text: "same" }]);
  });
  it("wordDiff falls back to a whole replace past the size cap", () => {
    const before = "old ".repeat(500), after = "new ".repeat(500);
    expect(wordDiff(before, after)).toEqual([{ op: "del", text: before }, { op: "add", text: after }]);
  });
  it("revertableKeys keeps only the revertable items of one run", () => {
    const item: DiffItem = { key: "block:p:b", kind: "block", change: "edited", page_id: "p", block_id: "b", status: "revertable",
      before_text: "Before", after_text: "After", after_rev: 2, current_rev: 2, summary: "Edited", first_seq: 1, last_seq: 2 };
    const run: RunDiff = { run_id: "r", agent_id: "a", harness: "codex", status: "completed", started_at: "", ended_at: null,
      hidden_items: 0, items: [item, { ...item, key: "other", status: "changed_since" }] };
    expect(revertableKeys(run)).toEqual([item.key]);
  });
  it("itemLabel names a block by the start of its text and falls back to the summary", () => {
    const item: DiffItem = { key: "block:p:b", kind: "block", change: "added", page_id: "p", block_id: "b", status: "revertable",
      before_text: "", after_text: `  Quarterly   report
${"x".repeat(80)}`, after_rev: 1, current_rev: 1, summary: "Appended 2 block(s)", first_seq: 1, last_seq: 1 };
    const label = itemLabel(item);
    expect(label.startsWith('Added: "Quarterly report x')).toBe(true);
    expect(label.endsWith('…"')).toBe(true);
    expect(label.length).toBe('Added: ""'.length + 60);
    expect(itemLabel({ ...item, change: "edited", after_text: "", before_text: "Old text" })).toBe('Edited: "Old text"');
    expect(itemLabel({ ...item, after_text: null })).toBe("Appended 2 block(s)");
    expect(itemLabel({ ...item, kind: "row", key: "row:p:r", block_id: undefined, after_text: null, before_text: null, summary: "Set 2 cell(s)" })).toBe("Set 2 cell(s)");
  });
  it("itemLabel never cuts a character made of two code units in half", () => {
    const item: DiffItem = { key: "block:p:b", kind: "block", change: "added", page_id: "p", block_id: "b", status: "revertable",
      before_text: "", after_text: "a".repeat(58) + "\u{1F680}\u{1F680}\u{1F680}", after_rev: 1, current_rev: 1, summary: "Appended 1 block(s)", first_seq: 1, last_seq: 1 };
    const label = itemLabel(item);
    expect(label).toBe(`Added: "${"a".repeat(58)}\u{1F680}…"`);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("isRunActive is true while the run is running or waiting", () => {
    expect(["running", "waiting", "completed", "failed", "cancelled"].map((status) => isRunActive({ status }))).toEqual([true, true, false, false, false]);
  });
  it("statusLabel names every status", () => {
    const expected: Record<DiffStatus, string> = { revertable: "Can be reverted", changed_since: "Changed after the run: revert by hand",
      gone: "Deleted after the run", manual: "Revert by hand", reverted: "Reverted" };
    for (const [status, label] of Object.entries(expected)) expect(statusLabel(status as DiffStatus)).toBe(label);
  });
});
