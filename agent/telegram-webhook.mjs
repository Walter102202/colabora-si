// Run separately from the agent: the webhook secret belongs only to server setup.
import { pathToFileURL } from "node:url";

export async function setTelegramWebhook({ token, secret, url, apiBase = "https://api.telegram.org", fetchImpl = fetch }) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !token || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new Error("Invalid webhook configuration.");
  const response = await fetchImpl(`${apiBase}/bot${token}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error("Webhook registration failed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await setTelegramWebhook({ token: process.env.TELEGRAM_BOT_TOKEN, secret: process.env.TELEGRAM_WEBHOOK_SECRET, url: process.env.TELEGRAM_WEBHOOK_URL });
    console.log("Telegram webhook registered.");
  } catch {
    console.error("Webhook registration failed. Check the server setup variables.");
    process.exitCode = 1;
  }
}
