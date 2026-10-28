import { Input } from "@/components/FormControls";
import { useState } from "react";
import { safeHref } from "@/lib/utils";
export default function FilesCell({ value, onChange, readOnly }: { value: unknown; onChange: (urls: string[]) => void; readOnly: boolean }) {
  const urls: string[] = Array.isArray(value) ? value.map(String) : [], [open, setOpen] = useState(false), [draft, setDraft] = useState("");
  const save = () => { if (draft.trim()) onChange([...urls, draft.trim()]); setDraft(""); setOpen(false); };
  return <div className="flex flex-wrap items-center gap-1 p-1">{urls.map((url, i) => { let name = url; try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || url); } catch {} return <a key={i} href={safeHref(url)} target="_blank" rel="noopener noreferrer" className="max-w-40 truncate rounded bg-bg-secondary px-1 text-xs text-accent">📎 {name}</a>; })}{!readOnly && (open ? <Input label="Paste URL…" className="cell-input w-28" focusOnMount placeholder="Paste URL…" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } if (e.key === "Escape") { setDraft(""); setOpen(false); } }} /> : <button className="icon-button" aria-label="Add file URL" onClick={() => setOpen(true)}>+</button>)}</div>;
}
