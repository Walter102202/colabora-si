import type { Model } from "../model.mjs";

export interface ScriptStep {
  content?: string;
  tool_calls?: { name: string; arguments?: Record<string, unknown> }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}
export type StubFailure = { status: number; retryAfter?: number } | { timeout: true; holdMs?: number };
export function toolCall(name: string, args?: Record<string, unknown>): { name: string; arguments: Record<string, unknown> };
export function completionFor(step: ScriptStep | undefined, index: number): Record<string, any>;
export function createStubModel(script: ScriptStep[], opts?: { name?: string }): Model & { requests: { messages: any[]; tools?: any[] }[] };
export function startStubModelServer(
  script: ScriptStep[],
  opts?: { port?: number; failures?: StubFailure[] },
): Promise<{ url: string; requests: any[]; close: () => Promise<void> }>;
