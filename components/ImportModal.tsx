"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";
import { markdownToPage } from "@/lib/markdown";
import { sanitizeBlocks } from "@/lib/seed";
import { useStore } from "@/lib/store";
import { withViewTransition } from "@/lib/viewTransition";
import { readZip } from "@/lib/zip";
export default function ImportModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [error, setError] = useState(""), input = useRef<HTMLInputElement>(null), router = useRouter();
  const [archive, setArchive] = useState<{ name: string; entries: { path: string; text: string }[] } | null>(null);
  const run = () => {
    if (!archive) { const parsed = markdownToPage(text), id = useStore.getState().createPage(null, { title: title.trim() || parsed.title, icon: parsed.icon, blocks: sanitizeBlocks(parsed.blocks) }); onClose(); withViewTransition(() => router.push(`/p/${id}`)); return; }
    const folders = new Map<string, string>(); let first = "";
    const ensureFolder = (path: string): string | null => { if (!path) return null; if (folders.has(path)) return folders.get(path)!; const parts = path.split("/"), title = parts.pop()!, parentId = ensureFolder(parts.join("/")), id = useStore.getState().createPage(parentId, { title, icon: "📁" }); folders.set(path, id); return id; };
    for (const entry of [...archive.entries].sort((a, b) => a.path.localeCompare(b.path, "en-US"))) {
      const segments = entry.path.split("/").filter(Boolean), base = segments.pop()!.replace(/\.(md|markdown)$/i, ""), parentId = ensureFolder(segments.join("/")), parsed = markdownToPage(entry.text);
      const id = useStore.getState().createPage(parentId, { title: parsed.title !== "Imported" ? parsed.title : base, icon: parsed.icon, blocks: sanitizeBlocks(parsed.blocks) }); first ||= id;
    }
    onClose(); if (first) withViewTransition(() => router.push(`/p/${first}`));
  };
  return <Modal title="Import Markdown" onClose={onClose}><div className="space-y-3 p-5"><input className="auth-input" placeholder="Page title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />{archive ? <div className="rounded border border-border p-3 text-sm"><strong>{archive.name}</strong><p>{archive.entries.length} Markdown {archive.entries.length === 1 ? "file" : "files"} — folders become nested pages.</p><div className="max-h-36 overflow-y-auto font-mono text-xs">{archive.entries.map((entry) => <p key={entry.path}>{entry.path}</p>)}</div><button className="mt-2 text-accent" onClick={() => setArchive(null)}>Clear</button></div> : <textarea className="auth-input h-56 resize-none font-mono" placeholder="Paste Markdown here, or upload a .md file or a .zip of .md files…" value={text} onChange={(e) => setText(e.target.value)} />}{error && <p role="alert" className="danger text-xs">{error}</p>}<input ref={input} className="sr-only" type="file" accept=".md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; setError(""); if (/\.zip$/i.test(file.name)) { try { const entries = (await readZip(await file.arrayBuffer())).filter((entry) => !entry.dir && /\.(md|markdown)$/i.test(entry.name) && !entry.name.split("/").some((part) => part.startsWith(".") || part === "__MACOSX")).map((entry) => ({ path: entry.name, text: new TextDecoder().decode(entry.data) })); if (!entries.length) { setError("No .md files found in that zip."); return; } setArchive({ name: file.name, entries }); } catch { setError("Could not read that zip file."); } return; } try { setArchive(null); setText(await file.text()); if (!title.trim()) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, "")); } catch { setError("Could not read that file."); } }} /><div className="flex justify-between"><button className="action-button" onClick={() => input.current?.click()}>Upload file</button><button className="action-button text-accent" disabled={!text.trim() && !archive} onClick={run}>{archive ? `Import ${archive.entries.length} pages` : "Import"}</button></div></div></Modal>;
}
