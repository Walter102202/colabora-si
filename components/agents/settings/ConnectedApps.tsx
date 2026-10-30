import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { connectedApps, disconnectApp, type ConnectedApp } from "@/lib/agentConsent";

export function ConnectedApps() {
  const client = getSupabase();
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void connectedApps(client).then((data) => { if (!cancelled) setApps(data); })
      .catch(() => { if (!cancelled) setError("Could not load connected apps."); });
    return () => { cancelled = true; };
  }, [client]);
  const disconnect = async (app: ConnectedApp) => {
    if (!client || busy) return;
    setBusy(app.clientId); setError(null);
    try { await disconnectApp(client, app.clientId, app.linked); }
    catch { setError("Could not finish disconnecting this app. Try again."); }
    try { setApps(await connectedApps(client)); }
    catch { setError("Could not refresh connected apps. Reopen settings to try again."); }
    finally { setBusy(null); }
  };
  if (!client) return null;
  return <section className="space-y-3 border-t border-border pt-4" aria-labelledby="connected-apps-title">
    <h3 id="connected-apps-title" className="font-medium">Connected apps</h3>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    {apps === null ? <p aria-busy={!error}>Loading…</p> : apps.length === 0 ? <p className="text-sm text-text-secondary">No apps connected.</p> :
      <ul className="space-y-2">{apps.map((app) => <li key={app.clientId} className="flex items-center justify-between gap-3 text-sm">
        <div><p>{app.name}</p><p className="text-text-secondary">As {app.agentName ?? "you"}{app.revoked ? " · disconnected" : ""}</p></div>
        <button type="button" className="rounded border border-border px-2 py-1 disabled:opacity-50" disabled={Boolean(busy)} onClick={() => void disconnect(app)}>Disconnect</button>
      </li>)}</ul>}
  </section>;
}
