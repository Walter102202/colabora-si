export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
}
export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, any> };
}
export interface ToolResult {
  isError: boolean;
  data: Record<string, any>;
  text: string;
}
export interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  instructions?: string;
}
export class McpError extends Error {
  constructor(message: string, code?: number, status?: number);
  code?: number;
  status?: number;
}
export function toOpenAiTools(tools: McpTool[]): OpenAiTool[];
export function toToolResult(result: unknown): ToolResult;
export function createMcpClient(opts: {
  url: string;
  pat: string;
  tokenUrl: string;
  fetchImpl?: typeof fetch;
  clientName?: string;
  timeoutMs?: number;
}): McpClient;
