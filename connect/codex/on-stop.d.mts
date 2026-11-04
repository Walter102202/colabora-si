export declare const MAX_REASON_CHARS: number;
export declare const DEFAULT_WAIT_MIN: number;
export declare const CONTINUE_REASONS: Set<string>;
export declare function isLeadNotice(task: unknown): boolean;
export declare const FINISHED_STATES: Set<string>;
export declare function feedbackExcerpt(detail: unknown): string;
export declare function feedbackPrompt(detail: unknown): { author_type?: string; body?: { source?: string } } | undefined;
export declare function buildReason(
  task: { task_id: string; title?: string; reason?: string; brief_version?: number; notice?: { event_id: string; type: string; payload?: Record<string, unknown> } },
  excerpt: string,
  prompt?: { author_type?: string; body?: { source?: string } },
): string;
export declare function runStopHook(options: {
  input: { stop_hook_active?: boolean; [key: string]: unknown };
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  clientInfo?: { name: string; version: string };
  state?: { load(): { delivered?: Record<string,string> }; save(state: { delivered: Record<string,string> }): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<{ exitCode: number; output?: string; acknowledge?: () => Promise<void> }>;
