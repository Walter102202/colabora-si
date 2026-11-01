import { pauseHistory, resumeHistory } from "@/lib/history";

let depth = 0;
export function isApplyingExternal(): boolean { return depth > 0; }
export function applyingExternal<T>(run: () => T): T {
  depth++; pauseHistory();
  try { return run(); } finally { resumeHistory(); depth--; }
}
