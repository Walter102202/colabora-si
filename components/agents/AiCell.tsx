import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Database, DbProperty, DbRow } from "@/lib/types";
import { aiCellText, isAiCellValue } from "@/lib/dbCompute";
import { aiRequestError, requestAiFill, useAiRequests } from "@/lib/agentAiRequests";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { useAgentsStore } from "@/lib/agentsStore";
import { taskUrl } from "@/lib/routes";
import { getSupabase } from "@/lib/supabase";

export function AiCell({ row, property, database, readOnly, onChange }: {
  row: DbRow; property: DbProperty; database: Database; readOnly: boolean; onChange: (value: unknown) => void;
}) {
  const pageId = useStore((s) => s.pages[row.pageId]?.parentId ?? Object.values(s.pages).find((p) => p.database?.id === database.id)?.id ?? "");
  const userId = useAuthStore((s) => s.user?.id);
  const requests = useAiRequests(pageId);
  const agents = useAgentsStore((s) => s.agents);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const value = row.cells[property.id], text = aiCellText(value), signed = isAiCellValue(value) ? value : null;
  const generating = requests.some((r) => r.kind === "fill" && !["done", "failed", "cancelled"].includes(r.state)
    && r.request.property_id === property.id && r.request.row_ids?.includes(row.id));
  const name = agents.find((a) => a.id === signed?.agentId)?.name ?? "Agent";
  const input = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  };
  const latest = useRef({ text, readOnly, userId, onChange });
  useEffect(() => { latest.current = { text, readOnly, userId, onChange }; });
  const save = () => {
    const current = input.current, state = latest.current;
    if (!current || state.readOnly || current.value === state.text) return;
    const text = current.value.slice(0, 4000);
    state.onChange(text ? state.userId ? { text, by: "human", id: state.userId, at: Date.now() } : text : null);
    latest.current = { ...state, text };
  };
  useEffect(() => { if (input.current && document.activeElement !== input.current) input.current.value = text; resize(); }, [text]);
  // Virtualized tables can unmount a focused row without firing blur.
  useLayoutEffect(() => () => save(), []);
  const generate = async () => {
    setPending(true); setError("");
    try { await requestAiFill(pageId, property.id, "empty", [row.id]); }
    catch (cause) { setError(aiRequestError(cause)); }
    finally { setPending(false); }
  };
  return <div className="ai-cell">
    {readOnly ? <span>{text}</span> : <textarea ref={input} aria-label={property.name} defaultValue={text} maxLength={4000} rows={1} onInput={resize} onBlur={save} />}
    {signed?.by === "agent" && signed.taskId && <a className="ai-cell-sign" aria-label={`Filled by ${name}`} title={`${name} · run ${signed.runId ?? ""}`} href={taskUrl(pageId, signed.taskId)}>✦ {name}</a>}
    {signed?.error && <span role="alert">{signed.error}</span>}
    {generating || pending ? <span role="status" className="ai-cell-generating">Generating…</span> : !readOnly && !text && getSupabase() && <button onClick={() => void generate()} disabled={!pageId}>{signed?.error ? "Retry" : "Generate"}</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
