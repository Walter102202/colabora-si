import type { McpClient } from "./mcpClient.mjs";
import type { Model } from "./model.mjs";

export interface ChannelEvent {
  kind: "claimed" | "approval_pending" | "input_requested" | "delivered" | "stopped" | "ended" | "error";
  task_id: string;
  text: string;
  link?: string;
}
export interface Channel {
  notify(event: ChannelEvent): Promise<void> | void;
}
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface TaskOutcome {
  task_id: string;
  run_id: string | null;
  outcome: "submitted" | "ended" | "stopped" | "error" | "max_turns" | "aborted";
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
}
export const RUNTIME_TOOLS: Set<string>;
export const REQUEST_TOOLS: Set<string>;
export const HEARTBEAT_INTERVAL_MS: number;
export const realClock: Clock;
export function costUsd(usage: { input_tokens: number; output_tokens: number }, prices: { input: number; output: number }): number;
export function runAgent(opts: {
  mcp: McpClient;
  model: Model;
  channel?: Channel;
  clock?: Clock;
  maxTurns?: number;
  maxTasks?: number;
  harness?: string;
  displayName?: string;
  reviewerAgentId?: string;
  resume?: boolean;
  modelVision?: boolean;
  modelPdf?: boolean;
  prices?: { input: number; output: number };
  appUrl?: string;
  signal?: AbortSignal;
  waitTimeoutS?: number;
  log?: (msg: string) => void;
  noticeState?: { load(): { delivered?: Record<string,string> }; save(state: { delivered: Record<string,string> }): void };
}): Promise<{ tasks: TaskOutcome[] }>;
