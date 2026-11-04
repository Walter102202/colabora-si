import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { forgetAll, forgetMemory, loadMemories, setMemoryEnabled, updateMemory, type PersonMemory } from "@/lib/agentMemory";
import { agentErrorMessage } from "@/lib/agentClient";

export function MemorySettingsTab() {
  const workspaceId = useStore((s) => s.syncWorkspaceId);
  return workspaceId ? <WorkspaceMemory key={workspaceId} workspaceId={workspaceId} /> : <p>Sign in to manage memory.</p>;
}

function WorkspaceMemory({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<{ memories: PersonMemory[]; enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [body, setBody] = useState("");
  useEffect(() => {
    let active = true;
    void loadMemories(workspaceId).then((value) => { if (active) setData(value); }, (e: unknown) => { if (active) setError(agentErrorMessage(e)); });
    return () => { active = false; };
  }, [workspaceId]);
  async function change(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); setData(await loadMemories(workspaceId)); setEditing(null); }
    catch (e) { setError(agentErrorMessage(e)); }
    finally { setBusy(false); }
  }
  const list = (memories: PersonMemory[]) => <ul className="space-y-4">{memories.map((memory) => <li key={memory.id} className="rounded-lg border border-border p-3">
    {editing === memory.id ? <form onSubmit={(e) => { e.preventDefault(); void change(() => updateMemory(memory.id, body)); }}>
      <label className="block">Memory text<textarea className="mt-1 w-full rounded border border-border p-2" value={body} onChange={(e) => setBody(e.target.value)} minLength={3} maxLength={500} required /></label>
      <button className="action-button" disabled={busy} type="submit">Save</button>
      <button className="action-button" disabled={busy} type="button" onClick={() => setEditing(null)}>Cancel</button>
    </form> : <p className="whitespace-pre-wrap">{memory.body}</p>}
    <p className="mt-1 text-xs text-text-secondary">You said: "{memory.source_quote}"</p>
    <div className="mt-2 flex gap-2">
      <button className="action-button" disabled={busy} onClick={() => { setEditing(memory.id); setBody(memory.body); }}>Edit</button>
      <button className="action-button" disabled={busy} onClick={() => { void change(() => forgetMemory(memory.id)); }}>Forget</button>
    </div>
  </li>)}</ul>;
  const replaced = data?.memories.filter((m) => m.status === "superseded") ?? [];
  return <div className="space-y-5 text-sm">
    <p>Trama remembers what you tell it in this workspace. Only you can see this.</p>
    {error && <p role="alert" className="danger">{error}</p>}
    {!data ? <p role="status">{error ? "Memory couldn't be loaded." : "Loading memory…"}</p> : <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={data.enabled} disabled={busy} onChange={(e) => { const enabled = e.target.checked; void change(() => setMemoryEnabled(workspaceId, enabled)); }} />Remember things I tell Trama</label>
      {data.memories.length === 0 && <p className="text-text-secondary">Nothing yet. Say "remember that..." to Trama, or just keep talking.</p>}
      {list(data.memories.filter((m) => m.status === "active"))}
      {replaced.length > 0 && <details><summary className="mb-3 cursor-pointer">Replaced</summary>{list(replaced)}</details>}
      <button className="action-button danger" disabled={busy || data.memories.length === 0} onClick={() => {
        if (confirm("Forget everything Trama remembers about you in this workspace? This can't be undone.")) void change(() => forgetAll(workspaceId));
      }}>Forget everything</button>
    </>}
  </div>;
}
