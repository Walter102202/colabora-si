// What a person sends on a chat channel reaches the workspace here. This is runtime code: no model takes part. One chat
// is handled in order, so a text sent right after a voice note waits for its transcript.

const MAX_VOICE_SECONDS = 600;
// What the Telegram Bot API lets a bot download.
const MAX_VOICE_BYTES = 20_000_000;
const MAX_ECHO_CHARS = 3500;

const TEXT = {
  es: {
    unsupported: "Por ahora solo leo texto y notas de voz.",
    too_long: "La nota de voz pasa de 10 minutos. Mándala más corta.",
    no_speech: "No escuché nada en ese audio.",
    no_ffmpeg: "Este agente todavía no puede convertir audio.",
    voice_quota: "Llegaste al límite de voz por ahora. Prueba más tarde o escríbeme.",
    budget_exceeded: "El agente llegó a su presupuesto de este mes. Escríbeme en texto.",
    failed: "No pude transcribir ese audio. Mándalo de nuevo o escríbeme.",
    not_saved: "No pude entregar tu mensaje. Inténtalo de nuevo.",
    heard: "Entendí",
    forwarded: "Audio reenviado",
  },
  en: {
    unsupported: "For now I only read text and voice notes.",
    too_long: "That voice note is over 10 minutes. Send a shorter one.",
    no_speech: "I heard nothing in that audio.",
    no_ffmpeg: "This agent cannot convert audio yet.",
    voice_quota: "You reached the voice limit for now. Try later or write to me.",
    budget_exceeded: "The agent reached its budget for this month. Write to me instead.",
    failed: "I could not transcribe that audio. Send it again or write to me.",
    not_saved: "I could not deliver your message. Try again.",
    heard: "I heard",
    forwarded: "Forwarded audio",
  },
};

/**
 * @typedef {object} ChannelMessage
 * @property {string} chatId
 * @property {number} messageId
 * @property {"es"|"en"} lang
 * @property {string} [text]
 * @property {{fileId: string, seconds: number, bytes: number}} [voice]
 * @property {boolean} forwarded  from the channel's own metadata, never from the content
 * @property {string} [quoteText]
 * @property {number} [quoteMessageId]
 * @property {boolean} [unsupported]
 */

/**
 * @param {{
 *   call: (name: string, args: Record<string, unknown>) => Promise<{isError: boolean, data: Record<string, any>, text: string}>,
 *   transcribe: (m: ChannelMessage) => Promise<{duplicate?: boolean, clip_id?: string, transcript?: string}>,
 *   send: (chatId: string, text: string) => Promise<unknown>,
 *   typing?: (chatId: string) => () => void,
 *   appUrl?: string, timezone?: string, log?: (msg: string) => void,
 * }} opts
 */
export function createInbox({ call, transcribe, send, typing = () => () => {}, timezone = "", log = () => {} }) {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  /** @param {ChannelMessage} m @param {string} text @param {"text"|"voice"} kind @param {string} [clipId] */
  async function relay(m, text, kind, clipId) {
    const result = await call("relay_person_message", {
      chat_id: m.chatId, message_id: m.messageId, text, kind, forwarded: m.forwarded,
      ...(m.quoteText ? { quote_text: m.quoteText } : {}), ...(m.quoteMessageId ? { quote_message_id: m.quoteMessageId } : {}),
      ...(clipId ? { voice_clip_id: clipId } : {}), ...(timezone ? { timezone } : {}),
    });
    if (result.isError) throw new Error(result.data?.code ?? "relay_failed");
    return result.data;
  }

  /** @param {Record<string, any>} data */
  function confirmation(data) {
    if (data.duplicate || !data.reply || !["note_undone", "nothing_to_undo"].includes(data.outcome?.kind)) return "";
    return data.reply;
  }

  /** @param {ChannelMessage} m */
  async function handle(m) {
    const t = TEXT[m.lang];
    if (m.unsupported) return send(m.chatId, t.unsupported);
    if (m.text) {
      try {
        const reply = confirmation(await relay(m, m.text, "text"));
        if (reply) await send(m.chatId, reply);
      } catch (e) {
        log(`inbox: ${e instanceof Error ? e.message : String(e)}`);
        await send(m.chatId, t.not_saved);
      }
      return;
    }
    if (!m.voice) return;
    if (m.voice.seconds > MAX_VOICE_SECONDS || m.voice.bytes > MAX_VOICE_BYTES) return send(m.chatId, t.too_long);
    const stop = typing(m.chatId);
    try {
      const heard = await transcribe(m);
      if (heard.duplicate) return;
      if (!heard.transcript) return await send(m.chatId, t.no_speech);
      const data = await relay(m, heard.transcript, "voice", heard.clip_id);
      if (data.duplicate) return;
      const echo = `${m.forwarded ? t.forwarded : t.heard}: "${heard.transcript.slice(0, MAX_ECHO_CHARS)}"`;
      await send(m.chatId, [echo, confirmation(data)].filter(Boolean).join("\n\n"));
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      log(`inbox voice: ${code}`);
      await send(m.chatId, /** @type {any} */ (t)[code] ?? t.failed);
    } finally {
      stop();
    }
  }

  return {
    /** @param {ChannelMessage} m */
    deliver(m) {
      const next = (tails.get(m.chatId) ?? Promise.resolve()).then(() => handle(m)).catch((e) => log(`inbox: ${e instanceof Error ? e.message : String(e)}`));
      tails.set(m.chatId, next);
      return next;
    },
  };
}

/** Retries persisted replies without another model turn or note write. A failed send remains in the server outbox. */
export async function flushPersonReplies({ call, reply, appUrl = "" }) {
  const result = await call("deliver_person_replies", {});
  if (result.isError) return;
  for (const message of result.data.messages ?? []) {
    try {
      await reply(message.chat_id, message.text + (message.note_page_id && appUrl ? `\n${appUrl}/p/${message.note_page_id}` : ""));
      const ack = await call("deliver_person_replies", { ack_message_id: message.message_id });
      if (ack.isError) break;
    } catch { break; }
  }
}
