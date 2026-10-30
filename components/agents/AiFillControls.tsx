import { useState } from "react";
import type { DbProperty } from "@/lib/types";
import { buildDbOps } from "@/lib/dbOps";
import { useStore } from "@/lib/store";
import { useAgentsStore } from "@/lib/agentsStore";
import { aiRequestError, requestAiFill, useAiRequests } from "@/lib/agentAiRequests";
import { getSupabase } from "@/lib/supabase";

export function AiFillControls({ dbPageId, property, rowCount, readOnly }: {
  dbPageId: string; property: DbProperty; rowCount: number; readOnly: boolean;
}) {
  const database = useStore((s) => s.pages[dbPageId]?.database);
  const agents = useAgentsStore((s) => s.agents);
  const requests = useAiRequests(dbPageId);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [nextRows, setNextRows] = useState<string[] | null>(null);
  const ops = buildDbOps(dbPageId);
  const running = requests.some((r) => r.kind === "fill" && !["done", "failed", "cancelled"].includes(r.state));
  const fill = async (mode: "empty" | "all", rowIds?: string[]) => {
    setBusy(true); setMessage("");
    try {
      const available = new Set(database?.rows.map((r) => r.id));
      const targets = mode === "all" ? (rowIds ?? [...available]).filter((id) => available.has(id)) : null;
      // Explicit batches keep continuation correct even if another person reorders the database.
      const result = await requestAiFill(dbPageId, property.id, mode, targets?.slice(0, 50));
      const next = targets?.slice(50) ?? null, left = next?.length ?? result.remaining;
      setNextRows(next); setRemaining(left);
      setMessage(result.rows ? `Filling ${result.rows} rows.${left ? ` ${left} more after this one.` : ""}` : "No empty rows to fill.");
    } catch (error) { setMessage(aiRequestError(error)); }
    finally { setBusy(false); }
  };
  if (!database) return null;
  return <div className="p-2 text-xs">
    <label>AI instruction<textarea aria-label="AI instruction" className="cell-input" maxLength={4000} defaultValue={property.aiPrompt ?? ""} disabled={readOnly}
      onBlur={(e) => ops.updateProperty(property.id, { aiPrompt: e.target.value })} /></label>
    <fieldset disabled={readOnly}><legend>Use these properties</legend>{database.properties.filter((p) => p.type !== "ai").map((p) => <label key={p.id} className="flex gap-2">
      <input type="checkbox" checked={!property.aiInputs || property.aiInputs.includes(p.id)} onChange={(e) => {
        const selected = property.aiInputs ?? database.properties.filter((p) => p.type !== "ai").map((p) => p.id);
        ops.updateProperty(property.id, { aiInputs: e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id) });
      }} />{p.name}</label>)}</fieldset>
    <label>Agent<select aria-label="Agent" className="cell-input" value={property.aiAgentId ?? ""} disabled={readOnly}
      onChange={(e) => ops.updateProperty(property.id, { aiAgentId: e.target.value || undefined })}>
      <option value="">Colabora (default)</option>{agents.filter((a) => a.status === "enabled" && !a.revoked_at).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select></label>
    <button disabled={readOnly || busy || running || !rowCount || !getSupabase()} onClick={() => void fill("empty")}>Fill empty</button>
    <button disabled={readOnly || busy || running || !rowCount || !getSupabase()} onClick={() => void fill("all")}>Regenerate all</button>
    {message && <p role="status">{message}</p>}
    {remaining > 0 && <button disabled={busy || running || readOnly} onClick={() => void (nextRows ? fill("all", nextRows) : fill("empty"))}>Fill the next 50</button>}
  </div>;
}
