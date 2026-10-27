// The colabora MCP server definition: tools, prompts, resources and instructions.
import type { McpServer } from '../_shared/mcp.ts';
import { INSTRUCTIONS, PROMPTS, RESOURCES } from '../_shared/tools/prompts.ts';
import { readTools } from '../_shared/tools/read.ts';
import { taskTools } from '../_shared/tools/tasks.ts';
import { waitTools } from '../_shared/tools/wait.ts';
import { writeTools } from '../_shared/tools/write.ts';

export function buildServer(): McpServer {
  return {
    name: 'colabora',
    title: 'colabora.si workspace',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [...readTools, ...writeTools, ...taskTools, ...waitTools],
    prompts: PROMPTS,
    resources: RESOURCES,
  };
}
