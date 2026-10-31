import type { Model } from "./model.mjs";
import type { ToolResult } from "./mcpClient.mjs";
export interface RequestOptions {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  model: Model;
  task: { task_id: string; request_kind: string };
  runId: string;
  log: (message: string) => void;
  prices?: { input: number; output: number };
  signal?: AbortSignal;
  reply?: (chatId: string, text: string) => Promise<unknown>;
  appUrl?: string;
}
export interface RequestOutcome {
  status: "completed" | "completed_with_errors" | "failed";
  summary: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
}
export const FILL_BATCH: number;
export const MAX_CELL_CHARS: number;
export function runRequest(opts: RequestOptions): Promise<RequestOutcome>;
export interface ExtractOptions {
  call: RequestOptions["call"];
  model: Model;
  runId: string;
  pageId: string;
  fileId: string;
  url: string;
  mime: string;
  prices?: { input: number; output: number };
  signal?: AbortSignal;
}
export function extractFile(opts: ExtractOptions): Promise<{ data: Record<string, any>; usage: RequestOutcome["usage"] }>;
