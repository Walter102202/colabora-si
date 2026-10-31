import type { ToolResult } from "./mcpClient.mjs";
export interface ChannelMessage {
  chatId: string;
  messageId: number;
  lang: "es" | "en";
  text?: string;
  voice?: { fileId: string; seconds: number; bytes: number };
  forwarded: boolean;
  quoteText?: string;
  quoteMessageId?: number;
  unsupported?: boolean;
}
export interface InboxOptions {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  transcribe: (m: ChannelMessage) => Promise<{ duplicate?: boolean; clip_id?: string; transcript?: string }>;
  send: (chatId: string, text: string) => Promise<unknown>;
  typing?: (chatId: string) => () => void;
  appUrl?: string;
  timezone?: string;
  log?: (message: string) => void;
}
export function createInbox(opts: InboxOptions): { deliver(m: ChannelMessage): Promise<unknown> };
export function flushPersonReplies(opts: { call: InboxOptions["call"]; reply: InboxOptions["send"]; appUrl?: string }): Promise<void>;
