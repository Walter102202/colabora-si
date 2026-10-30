import type { Model } from "./model.mjs";
import type { ToolResult } from "./mcpClient.mjs";
export interface RequestOptions {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  model: Model;
  task: { task_id: string; request_kind: string };
  runId: string;
  log: (message: string) => void;
  prices?: { input: number; output: number };
}
export interface RequestOutcome {
  status: "completed" | "completed_with_errors" | "failed";
  summary: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
}
export const FILL_BATCH: number;
export const MAX_CELL_CHARS: number;
export function runRequest(opts: RequestOptions): Promise<RequestOutcome>;
