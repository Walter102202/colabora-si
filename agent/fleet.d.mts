import type { McpClient } from "./mcpClient.mjs";

export const LIST_EVERY_MS: number;
/** The task endpoint alone, or the task and workspace endpoints composed into one client. */
export function buildMcp<C extends McpClient>(config: { mcpUrl: string; workspaceMcpUrl?: string }, make: (url: string) => C): C;
export function runFleet(opts: {
  listAgents: () => Promise<string[]>;
  serve: (agentId: string, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void>;
