// Telegram channel over the Bot API (fetch + long polling getUpdates).
// Tells the owner when a task is claimed, when a decision is pending (with a
// deep link to the task in the app) and when work is delivered. Decisions are
// always taken in the app, never in the chat. With an inbox, what the owner
// writes or says reaches the workspace as their message.

const ECHO = /^(?:Entendí|I heard|Audio reenviado|Forwarded audio): "([\s\S]*?)"(?:\n\n|$)/;

/**
 * What one Telegram message means to the workspace. `forwarded` comes from Telegram's own fields, never from the content.
 * A voice note is the only audio accepted: its format is known, and an audio file is someone else's recording.
 * @param {any} msg
 * @returns {import("../inbox.mjs").ChannelMessage}
 */
export function readMessage(msg) {
  const base = {
    chatId: String(msg.chat.id), messageId: msg.message_id,
    lang: /** @type {"es"|"en"} */ (String(msg.from?.language_code ?? "es").startsWith("en") ? "en" : "es"),
    forwarded: Boolean(msg.forward_origin ?? msg.forward_date),
  };
  const reply = msg.reply_to_message;
  const quoted = String(msg.quote?.text ?? reply?.text ?? "").trim();
  const quote = reply ? { quoteMessageId: reply.message_id, ...(quoted ? { quoteText: reply.from?.is_bot ? ECHO.exec(quoted)?.[1] ?? quoted : quoted } : {}) } : {};
  if (msg.voice) return { ...base, ...quote, voice: { fileId: msg.voice.file_id, seconds: Number(msg.voice.duration) || 0, bytes: Number(msg.voice.file_size) || 0 } };
  const text = String(msg.text ?? "").trim();
  return text ? { ...base, ...quote, text } : { ...base, unsupported: true };
}

/**
 * @param {{
 *   token: string, ownerChatId: string, fetchImpl?: typeof fetch,
 *   apiBase?: string, log?: (msg: string) => void,
 * }} opts
 */
export function createTelegramChannel({ token, ownerChatId, fetchImpl = globalThis.fetch, apiBase = "https://api.telegram.org", log = () => {} }) {
  const base = `${apiBase}/bot${token}`;

  /** @param {string} method @param {Record<string, unknown>} body @param {number} [timeoutMs] */
  async function api(method, body, timeoutMs = 15_000) {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? `HTTP ${res.status}`}`);
    return json.result;
  }

  /** @param {string} text @param {string} [chatId] */
  const send = (text, chatId = ownerChatId) => api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });

  const icons = { claimed: "Working on", approval_pending: "Needs you", input_requested: "Needs you", delivered: "Delivered", stopped: "Stopped", ended: "Paused", error: "Problem" };

  return {
    /** @param {import("../loop.mjs").ChannelEvent} event */
    async notify(event) {
      const lines = [`${icons[event.kind] ?? event.kind}: ${event.text}`];
      if (event.link) lines.push(event.kind === "approval_pending" || event.kind === "input_requested" ? `Decide here: ${event.link}` : event.link);
      await send(lines.join("\n"));
    },

    /** @param {string} chatId @param {string} text */
    reply: (chatId, text) => send(text.slice(0, 4000), chatId),

    /** Shows "typing…" until the returned function is called. @param {string} chatId */
    typing(chatId) {
      const tick = () => api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      void tick();
      const timer = setInterval(tick, 4500);
      return () => clearInterval(timer);
    },

    /**
     * The file's URL carries the bot token, so it never reaches a log or an error.
     * @param {string} fileId @param {number} [maxBytes]
     */
    async download(fileId, maxBytes = 8_700_000) {
      const file = await api("getFile", { file_id: fileId });
      if (!file?.file_path || Number(file.file_size) > maxBytes) throw new Error("too_long");
      const res = await fetchImpl(`${apiBase}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error("failed");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error("too_long");
      return bytes;
    },

    /**
     * Long-polls updates until `signal` aborts. Only the owner chat is answered:
     * `/status` returns `status()`. With `onMessage`, the rest goes there, only from
     * a private chat: in a group, anyone could speak as the owner. Without it, the
     * reply points to the app.
     * @param {{signal?: AbortSignal, status?: () => string, onMessage?: (m: import("../inbox.mjs").ChannelMessage) => unknown}} [opts]
     */
    async start({ signal, status = () => "idle", onMessage } = {}) {
      let offset = 0;
      const deliveries = new Map();
      while (!signal?.aborted) {
        try {
          for (const [id, done] of deliveries) {
            if (done !== true) break;
            offset = id + 1;
            deliveries.delete(id);
          }
          const updates = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
          for (const u of updates) {
            if (deliveries.has(u.update_id) && deliveries.get(u.update_id) !== "retry") continue;
            deliveries.set(u.update_id, true);
            const msg = u.message;
            if (!msg || String(msg.chat?.id) !== String(ownerChatId)) continue;
            const text = String(msg.text ?? "").trim();
            if (text.startsWith("/status")) await send(`Status: ${status()}`);
            else if (!onMessage) await send("Decisions and feedback go through the task in the app; open the link of the task message.");
            else if (msg.chat?.type === "private" && !msg.from?.is_bot) {
              deliveries.set(u.update_id, false);
              void Promise.resolve().then(() => onMessage(readMessage(msg))).then(
                () => deliveries.set(u.update_id, true),
                () => { deliveries.set(u.update_id, "retry"); log("telegram ingestion failed; delivery remains unacknowledged"); },
              );
            }
          }
          if ([...deliveries.values()].some((done) => done !== true)) await new Promise((r) => setTimeout(r, 100));
        } catch (e) {
          if (signal?.aborted) break;
          log(`telegram polling error: ${e instanceof Error ? e.message : String(e)}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    },
  };
}
