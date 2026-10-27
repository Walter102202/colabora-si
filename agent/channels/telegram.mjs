// Telegram channel over the Bot API (fetch + long polling getUpdates).
// Tells the owner when a task is claimed, when a decision is pending (with a
// deep link to the task in the app) and when work is delivered. Decisions are
// always taken in the app, never in the chat.

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

    /**
     * Long-polls updates until `signal` aborts. Only the owner chat is answered:
     * `/status` returns `status()`, anything else points to the app.
     * @param {{signal?: AbortSignal, status?: () => string}} [opts]
     */
    async start({ signal, status = () => "idle" } = {}) {
      let offset = 0;
      while (!signal?.aborted) {
        try {
          const updates = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
          for (const u of updates) {
            offset = u.update_id + 1;
            const msg = u.message;
            if (!msg || String(msg.chat?.id) !== String(ownerChatId)) continue;
            const text = String(msg.text ?? "").trim();
            if (text.startsWith("/status")) await send(`Status: ${status()}`);
            else await send("Decisions and feedback go through the task in the app; open the link of the task message.");
          }
        } catch (e) {
          if (signal?.aborted) break;
          log(`telegram polling error: ${e instanceof Error ? e.message : String(e)}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    },
  };
}
