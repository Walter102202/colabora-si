import type { McpServer } from '../_shared/mcp.ts';
import { readTools } from '../_shared/tools/read.ts';
import { writeTools } from '../_shared/tools/write.ts';
import { workspaceTools } from '../_shared/tools/workspace.ts';
export function buildWorkspaceServer(): McpServer {
  return {
    name: 'colabora-workspace', title: 'colabora.si pages and databases', version: '1.0.0',
    instructions: 'Work directly on pages and databases without tasks. Use a supplied writable parent directly; discover it with list_pages or search only when missing. Agents need write access to a parent; only a human session may create at the root with workspace_id. Use create_database once with properties, views and rows. Use property/view/option names or ids; query_database with limit:0 returns the schema. Send Markdown or AgentBlockInput, never HTML. Supply a unique idempotency_key for each write and reuse it on retries. Archive instead of deleting; restore_page undoes archive. For task work, connect the separate mcp endpoint too.',
    tools: [...readTools, ...writeTools, ...workspaceTools], prompts: [],
    resources: { list: async () => [], templates: [], read: async () => null },
  };
}
