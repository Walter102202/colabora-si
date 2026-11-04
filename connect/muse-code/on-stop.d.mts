export declare const CREDENTIAL_KEYS: string[];
export declare function defaultCredentialsPath(home?: string): string;
export declare function parseEnvFile(text: string): Record<string, string>;
export type CredentialOptions = {
  env?: Record<string, string | undefined>;
  argv?: string[];
  home?: string;
  readFile?: (path: string) => string;
  log?: (message: string) => void;
};
export declare function resolveCredentials(options: CredentialOptions): Record<string, string>;
export declare function museStatePath(sessionId: string, home?: string, override?: string): string | null;
export declare function redact(message: unknown, secrets: (string | undefined)[]): string;
export declare function runMuseStopHook(options: CredentialOptions & {
  input: { stop_hook_active?: boolean; session_id?: string; [key: string]: unknown } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stateFor?: (path: string) => {
    load(): { delivered?: Record<string, string> };
    save(state: { delivered: Record<string, string> }): void;
  };
}): Promise<{ exitCode: number; output?: string; acknowledge?: () => Promise<void> }>;
