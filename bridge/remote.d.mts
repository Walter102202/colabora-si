export declare const DEFAULT_PROTOCOL_VERSION: string;
export declare class RemoteError extends Error {
  constructor(code: string, status?: number, detail?: string);
  code: string;
  status: number | undefined;
}
export declare function defaultTokenUrl(mcpUrl: string): string;
export declare function readMessages(res: Response, onMessage?: (message: any) => void): Promise<any[]>;
export interface TokenExchangeResult {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  agent_id?: string;
  workspace_id?: string;
}
export interface Remote {
  exchange(): Promise<TokenExchangeResult>;
  ensureToken(): Promise<string>;
  call(body: unknown, opts?: { headers?: Record<string, string>; onMessage?: (message: any) => void }): Promise<{ status: number; messages: any[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<any>;
  readonly token: string | null;
  readonly agentId: string | null;
  readonly workspaceId: string | null;
  readonly expiresAt: number;
  readonly sessionId: string | null;
  readonly protocolVersion: string;
  setProtocolVersion(version: string): void;
  setInitParams(params: unknown): void;
  onToken(listener: (token: string) => void): () => boolean;
}
export declare function createRemote(options: {
  mcpUrl: string;
  pat: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  clientInfo?: { name: string; version: string };
}): Remote;
