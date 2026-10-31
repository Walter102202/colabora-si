export const LIST_EVERY_MS: number;
export function runFleet(opts: {
  listAgents: () => Promise<string[]>;
  serve: (agentId: string, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void>;
