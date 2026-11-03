import type { McpClient } from "./mcpClient.mjs";

export interface ComposedMcpClient extends McpClient {
  accessToken(fresh?: boolean): Promise<string>;
}

/**
 * One client over the task endpoint (primary) and the workspace endpoint (secondary).
 * Tool names on both sides belong to the primary; the merged list is sorted by name.
 */
export function composeMcp(primary: McpClient, secondary: McpClient): ComposedMcpClient;
