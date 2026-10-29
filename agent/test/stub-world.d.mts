import type { McpClient } from "../mcpClient.mjs";
export const CLAUDE_CODE: string; export const CODEX: string; export const PLAIN: string;
export function createStubWorld(): StubWorld;
export interface StubWorld {
  client(agentId: string): McpClient & { calls: WorldCall[] };
  human: {
    createTask(input: { title: string; delegate: string; done_when?: { id: string; text: string }[] }): string;
    decide(approvalId: string, decision: "approve" | "reject"): void;
    editBlock(pageId: string, blockId: string, text: string): void;
    releaseForHandover(taskId: string, toAgentId: string | null, note?: string): void;
    insertCheckpoint(taskId: string, body: Record<string, unknown>, harness: string): void;
  };
  faults: {
    loseResponses(agentId: string, tool: string, opts: { skip?: number; count: number }): void;
    killAfter(agentId: string, tool: string, nth: number): void;
  };
  script(agentId: string, tool: string, nth: number, action: () => void): void;
  task(id: string): Record<string, any>; runs(taskId: string): Record<string, any>[]; approvals(taskId: string): Record<string, any>[];
  activities(taskId: string): Record<string, any>[]; externalOps(taskId: string): Record<string, any>[];
  blocks(pageId: string): { id: string; text: string; rev: number; attr: Record<string, unknown> }[];
  calls(agentId: string): WorldCall[];
}
export interface WorldCall { name: string; args: Record<string, any>; outcome: string; result?: Record<string, any> }
