export declare const MAX_REASON_CHARS: number;
export declare const DEFAULT_WAIT_MIN: number;
export declare const CONTINUE_REASONS: Set<string>;
export declare function isLeadNotice(task: unknown): boolean;
export declare const FINISHED_STATES: Set<string>;
export declare function feedbackExcerpt(detail: unknown): string;
export declare function buildReason(
  task: { task_id: string; title?: string; reason?: string; brief_version?: number; notice?: { event_id: string; type: string; payload?: Record<string, unknown> } },
  excerpt: string,
): string;
export declare function runStopHook(options: {
  input: { stop_hook_active?: boolean; [key: string]: unknown };
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<{ exitCode: number; output?: string }>;
