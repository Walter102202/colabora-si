import { useEffect, useId, useState } from "react";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { canManageConnections, connectRepository, ghWebhookCommand, listConnections, revokeConnection, type CiConnection, type NewCiConnection } from "@/lib/agentCi";

export function CiConnections({ workspaceId }: { workspaceId: string | null }) {
  const id = useId();
  const client = getSupabase();
  const { user } = useAuth();
  const userId = user?.id;
  const [allowed, setAllowed] = useState(false);
  const [connections, setConnections] = useState<CiConnection[]>([]);
  const [repo, setRepo] = useState("");
  const [created, setCreated] = useState<NewCiConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !workspaceId || !userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const owner = await canManageConnections(client, workspaceId, userId);
        const rows = owner ? await listConnections(client, workspaceId) : [];
        if (!cancelled) { setAllowed(owner); setConnections(rows); }
      } catch { if (!cancelled) setError("Could not load continuous integration settings."); }
    })();
    return () => { cancelled = true; };
  }, [client, workspaceId, userId]);
  if (!client || !workspaceId || !userId) return null;
  if (!allowed) return error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null;
  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setCopied(false);
    try {
      setCreated(await connectRepository(client, workspaceId, repo.trim()));
      setRepo(""); setConnections(await listConnections(client, workspaceId));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not connect the repository."); }
    finally { setBusy(false); }
  };
  const disconnect = async (connection: CiConnection) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await revokeConnection(client, connection.id);
      if (created?.id === connection.id) setCreated(null);
      setConnections(await listConnections(client, workspaceId));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not disconnect the repository."); }
    finally { setBusy(false); }
  };
  const command = created ? ghWebhookCommand(created.repo, created.webhook_url, created.secret) : "";
  return <section className="space-y-3 border-t border-border pt-4" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="font-medium">Continuous integration</h3>
    <form onSubmit={(event) => void connect(event)} className="flex flex-wrap items-end gap-2">
      <label className="text-sm" htmlFor={`${id}-repo`}>Repository
        <input id={`${id}-repo`} className="mt-1 block rounded border border-border bg-bg px-2 py-1" placeholder="owner/name" required value={repo} onChange={(event) => setRepo(event.target.value)} disabled={busy} />
      </label>
      <button type="submit" className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50" disabled={busy || !repo.trim()}>Connect</button>
    </form>
    {created && <div className="space-y-2 rounded border border-border p-3 text-sm">
      <p>Run this command with your GitHub access to install the webhook.</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-bg-secondary p-2 text-xs"><code>{command}</code></pre>
      <p>This secret is shown once.</p>
      <button type="button" className="rounded border border-border px-2 py-1" onClick={async () => {
        try { await navigator.clipboard.writeText(command); setCopied(true); }
        catch { setError("Could not copy the command. Select and copy it above."); }
      }}>{copied ? "Copied" : "Copy"}</button>
    </div>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    <ul className="space-y-2">{connections.map((connection) => <li key={connection.id} className="flex items-center justify-between gap-3 text-sm">
      <div><p>{connection.repo}</p><p className="text-xs text-text-secondary">{connection.last_delivery_at ? `Last delivery ${new Date(connection.last_delivery_at).toLocaleString()}` : "Waiting for the first delivery"}</p></div>
      <button type="button" className="rounded border border-border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => void disconnect(connection)}>Disconnect</button>
    </li>)}</ul>
  </section>;
}
