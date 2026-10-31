import type { ChannelMessage } from "./inbox.mjs";
export function oggToWav(ogg: Uint8Array, opts?: { ffmpeg?: string; timeoutMs?: number }): Promise<Uint8Array>;
export interface VoiceClientOptions {
  url: string;
  accessToken: (fresh?: boolean) => Promise<string>;
  download: (fileId: string) => Promise<Uint8Array>;
  ffmpeg?: string;
  fetchImpl?: typeof fetch;
  retryMs?: number;
  convert?: typeof oggToWav;
}
export function createVoiceClient(opts: VoiceClientOptions): (m: ChannelMessage) => Promise<{ duplicate?: boolean; clip_id?: string; transcript?: string }>;
