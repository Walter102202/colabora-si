import type { ChannelMessage } from "../inbox.mjs";
export function readMessage(msg: unknown): ChannelMessage;
export interface TelegramOptions {
  token: string;
  ownerChatId: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  log?: (message: string) => void;
}
export function createTelegramChannel(opts: TelegramOptions): {
  notify(event: unknown): Promise<void>;
  reply(chatId: string, text: string): Promise<unknown>;
  typing(chatId: string): () => void;
  download(fileId: string, maxBytes?: number): Promise<Uint8Array>;
  start(opts?: { signal?: AbortSignal; status?: () => string; onMessage?: (m: ChannelMessage) => unknown }): Promise<void>;
};
