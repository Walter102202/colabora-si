import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/lib/auth";
import { disconnectTelegram, startTelegramLink, telegramLink } from "@/lib/agentChannels";
import { safeHref } from "@/lib/utils";

export function TelegramConnection({ workspaceId }: { workspaceId: string }) {
  const userId = useAuthStore((s) => s.user?.id);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setConnected(null); setUrl(null); setError(null); setBusy(false);
    const refresh = () => {
      if (userId) void telegramLink(workspaceId, userId).then((linked) => {
        if (version === generation.current) { setConnected(linked); if (linked) setUrl(null); }
      }).catch(() => { if (version === generation.current) setError("Could not read your Telegram connection."); });
    };
    refresh(); window.addEventListener("focus", refresh);
    return () => { generation.current++; window.removeEventListener("focus", refresh); };
  }, [workspaceId, userId]);
  const change = async () => {
    const version = generation.current;
    setBusy(true); setError(null);
    try {
      if (connected) { await disconnectTelegram(workspaceId); if (version === generation.current) { setConnected(false); setUrl(null); } }
      else { const link = await startTelegramLink(workspaceId); if (version === generation.current) setUrl(link); }
    } catch (e) { if (version === generation.current) setError(e instanceof Error ? e.message : "Connection failed."); }
    finally { if (version === generation.current) setBusy(false); }
  };
  return <section className="space-y-2 rounded border border-border p-3 text-sm" aria-label="Telegram connection">
    <h3 className="font-medium">Telegram</h3>
    <p className="text-xs text-text-secondary">{connected === null ? "Checking connection…" : connected ? "Connected to your account." : "Receive notices and answer with verified buttons. Payments, edits and delivery acceptance stay in the app."}</p>
    <button type="button" disabled={busy || connected === null || !userId} className="rounded border border-border px-3 py-1 disabled:opacity-50" onClick={() => void change()}>{connected ? "Disconnect" : "Connect Telegram"}</button>
    {url && <p><a href={safeHref(url)} target="_blank" rel="noreferrer" className="text-accent underline">Open Telegram</a><span className="ml-2 text-xs text-text-secondary">This one-use link expires in 10 minutes.</span></p>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>;
}
