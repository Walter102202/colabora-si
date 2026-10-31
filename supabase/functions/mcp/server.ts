// The colabora MCP server definition: tools, prompts, resources and instructions.
import type { McpServer } from '../_shared/mcp.ts';
import { INSTRUCTIONS, PROMPTS, RESOURCES } from '../_shared/tools/prompts.ts';
import { cardTools, withTaskCard } from '../_shared/tools/card.ts';
import { leadTools } from '../_shared/tools/lead.ts';
import { readTools } from '../_shared/tools/read.ts';
import { taskTools } from '../_shared/tools/tasks.ts';
import { handoverTools } from '../_shared/tools/handover.ts';
import { waitTools } from '../_shared/tools/wait.ts';
import { writeTools } from '../_shared/tools/write.ts';
import { lessonTools } from '../_shared/tools/lessons.ts';
import { sourceTools } from '../_shared/tools/sources.ts';
import { contextTools } from '../_shared/tools/context.ts';
import { aiTools } from '../_shared/tools/ai.ts';
import { personTools } from '../_shared/tools/person.ts';

export function buildServer(): McpServer {
  return {
    name: 'colabora',
    title: 'colabora.si workspace',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [...readTools, ...writeTools, ...taskTools, ...handoverTools, ...waitTools, ...leadTools, ...cardTools, ...aiTools, ...personTools, ...lessonTools, ...contextTools, ...sourceTools],
    prompts: PROMPTS,
    resources: withTaskCard(RESOURCES),
  };
}
