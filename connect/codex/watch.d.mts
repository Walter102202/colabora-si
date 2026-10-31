export declare const SESSION_HINT: string;
export declare function targetThread(task: { session_id?: unknown }, fallback?: string): string | null;
export declare function findCodex(env: Record<string, string | undefined>, fs?: {
  existsSync(path: string): boolean; readdirSync(path: string): string[]; statSync(path: string): { mtimeMs: number };
}): string;
export declare function codexQueue(bin: string | (() => string), run?: (
  file: string, args: string[], options: { timeout: number; windowsHide: boolean; env: Record<string, string | undefined> }, callback: (error: Error | null) => void,
) => unknown, env?: Record<string, string | undefined>): (thread: string, message: string) => Promise<void>;
export interface WatchSnapshot {
  cursor?: string;
  sent?: Record<string, string | string[]>;
  pending?: Record<string, unknown>;
}
export interface WatchState { load(): WatchSnapshot; save(state: WatchSnapshot): void }
export declare function fileState(path: string): WatchState;
export declare function runWatcher(options: {
  env: Record<string, string | undefined>;
  queue: (thread: string, message: string) => Promise<void>;
  state: WatchState;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<void>;
