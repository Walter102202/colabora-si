export interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}
export interface AgentEventRow {
  type: string;
  task_id: string;
  run_id?: string | null;
  agent_id?: string;
  payload?: any;
  event_id?: string;
}
export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<any>;
}
export type RealtimeFactory = (opts: { supabaseUrl: string; jwt: string }) => any;
export declare function untrustedText(value: unknown): string;
export declare function sanitizeMeta(meta: Record<string, unknown>): Record<string, string>;
export declare function oneLine(text: string): string;
export declare function eventToChannel(event: AgentEventRow): ChannelEvent;
export declare function taskToChannel(task: {
  task_id: string;
  title?: string;
  state?: string;
  reason?: string;
  pending_prompts?: number;
  active_run_id?: string;
  notice?: Pick<AgentEventRow, "type" | "payload" | "event_id">;
}): ChannelEvent;
export interface Channel {
  start(): Promise<void>;
  handleEvent(event: any): void;
  setAuth(token: string): void;
  stop(): void;
  readonly mode: "realtime" | "poll" | "idle";
  readonly cursor: string | undefined;
}
export declare function createChannel(options: {
  agentId: string;
  supabaseUrl?: string;
  jwt?: string;
  remote: ToolCaller;
  emit: (event: ChannelEvent) => void;
  realtimeFactory?: RealtimeFactory | null;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutS?: number;
}): Channel;
