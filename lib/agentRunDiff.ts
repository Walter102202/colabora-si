export type DiffStatus = "revertable" | "changed_since" | "gone" | "manual" | "reverted";
export interface DiffItem {
  key: string;
  kind: "block" | "row" | "schema" | "title" | "row_added" | "external";
  change: "added" | "edited" | "cells" | "manual";
  page_id: string;
  block_id?: string;
  row_id?: string;
  status: DiffStatus;
  before_text: string | null;
  after_text: string | null;
  after_rev: number | null;
  current_rev: number | null;
  summary: string;
  first_seq: number;
  last_seq: number;
}
export interface RunDiff {
  run_id: string; agent_id: string; harness: string; status: string;
  started_at: string; ended_at: string | null; items: DiffItem[]; hidden_items: number;
}
export interface TaskDiff { task_id: string; runs: RunDiff[]; hidden_items: number }
export type DiffPart = { op: "same" | "add" | "del"; text: string };

export function wordDiff(before: string, after: string, maxTokens = 400): DiffPart[] {
  const a = before.match(/\S+/g) ?? [], b = after.match(/\S+/g) ?? [];
  if (a.length > maxTokens || b.length > maxTokens) return [{ op: "del", text: before }, { op: "add", text: after }];
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const parts: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    const last = parts.at(-1);
    if (last?.op === op) last.text += ` ${text}`;
    else parts.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push("same", a[i++]); j++; }
    else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) push("del", a[i++]);
    else push("add", b[j++]);
  }
  return parts;
}

export function revertableKeys(run: RunDiff): string[] {
  return run.items.filter((item) => item.status === "revertable").map((item) => item.key);
}

export function statusLabel(status: DiffStatus): string {
  const labels: Record<DiffStatus, string> = { revertable: "Can be reverted", changed_since: "Changed after the run: revert by hand",
    gone: "Deleted after the run", manual: "Revert by hand", reverted: "Reverted" };
  return labels[status];
}
