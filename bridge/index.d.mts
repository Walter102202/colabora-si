import type { Channel, RealtimeFactory } from "./channel.mjs";
import type { Remote } from "./remote.mjs";

export declare const BRIDGE_VERSION: string;
export declare const DEFAULT_PROTOCOL_VERSION: string;
export interface BridgeConfig {
  mcpUrl: string;
  pat: string;
  tokenUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  channelOnly: boolean;
  noChannel: boolean;
  demoEventAfterMs: number | null;
  logFile: string;
}
export declare function buildInstructions(opts: { channel: boolean; channelOnly: boolean }): string;
export declare function resolveConfig(env: Record<string, string | undefined>, argv: string[]): BridgeConfig;
export interface Bridge {
  start(): Promise<void>;
  stop(): void;
  handleLine(line: string): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
  readonly remote: Remote | null;
  readonly channel: Channel | null;
}
export declare function createBridge(options: {
  config: BridgeConfig;
  write: (line: string) => void;
  log?: (message: string) => void;
  fetch?: typeof fetch;
  realtimeFactory?: RealtimeFactory | null;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutS?: number;
}): Bridge;
