import type { McpClient, McpTool } from "../mcpClient.mjs";

type Handler = (args: Record<string, any>) => Record<string, any> | { isError: true; data: Record<string, any> };
export const STUB_TOOLS: McpTool[];
export function createStubMcp(opts?: {
  tasks?: Record<string, any>[];
  heartbeats?: Record<string, any>[];
  waits?: Record<string, any>[];
  handlers?: Record<string, Handler>;
  instructions?: string;
}): McpClient & { calls: { name: string; args: Record<string, any> }[] };
