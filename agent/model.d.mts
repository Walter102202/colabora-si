export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
export interface ChatResult {
  message: AssistantMessage;
  usage: Usage;
  finish_reason?: string;
}
export interface Model {
  name: string;
  chat(req: { messages: object[]; tools?: object[] }): Promise<ChatResult>;
}
export function normalizeMessage(message: unknown): AssistantMessage;
export function createModel(opts: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Model;
