import { useState } from "react";
import { aiRequestError, requestAiRewrite } from "@/lib/agentAiRequests";

const PRESETS = [
  ["Shorter", "Make it shorter"], ["Clearer", "Make it clearer"],
  ["Fix spelling and grammar", "Fix spelling and grammar"], ["More formal", "Make it more formal"],
  ["Translate to English", "Translate it to English"],
];
export function AiRewritePanel({ pageId, blockId, selectionText, onDone }: {
  pageId: string; blockId: string; selectionText: string; onDone: () => void;
}) {
  const [instruction, setInstruction] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    try { await requestAiRewrite(pageId, blockId, text.trim(), selectionText); onDone(); }
    catch (cause) { setError(aiRequestError(cause)); }
    finally { setBusy(false); }
  };
  return <div className="menu-panel absolute left-0 top-full mt-1 w-72 p-2">
    {PRESETS.map(([label, instruction]) => <button key={label} disabled={busy} onClick={() => void send(instruction)}>{label}</button>)}
    <input aria-label="Ask AI to…" placeholder="Ask AI to…" className="cell-input" maxLength={500} value={instruction} disabled={busy}
      onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(instruction); } }} />
    <button disabled={busy || !instruction.trim()} onClick={() => void send(instruction)}>Rewrite</button>
    {busy && <p role="status">Requesting rewrite…</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
