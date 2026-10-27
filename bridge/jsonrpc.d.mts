export declare const JSONRPC_ERRORS: Readonly<{
  PARSE_ERROR: -32700;
  INVALID_REQUEST: -32600;
  METHOD_NOT_FOUND: -32601;
  INVALID_PARAMS: -32602;
  INTERNAL_ERROR: -32603;
}>;
export declare function createLineReader(onLine: (line: string) => void): { push(chunk: string): void; end(): void };
export declare function parseMessage(line: string): { ok: true; message: any } | { ok: false; error: string };
export declare function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};
export declare function isRequest(message: unknown): boolean;
export declare function isNotification(message: unknown): boolean;
export declare function isResponse(message: unknown): boolean;
export declare function createSseParser(onData: (data: string) => void): { push(chunk: string): void; end(): void };
