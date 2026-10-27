import type { ButtonAction } from "@/lib/types";

// Agent layer plug. The button executor of the workspace delegates the
// `agentTask` variant of ButtonAction here. Stub for now: does nothing.
export async function runAgentAction(action: ButtonAction, ctx: { pageId: string }): Promise<void> {
  void action;
  void ctx;
}
