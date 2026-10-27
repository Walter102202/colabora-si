"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";
import { markdownToPage } from "@/lib/markdown";
import { sanitizeBlocks } from "@/lib/seed";
import { useStore } from "@/lib/store";
import { withViewTransition } from "@/lib/viewTransition";
export default function ImportModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [error, setError] = useState(""), input = useRef<HTMLInputElement>(null), router = useRouter();
  const run = () => { const parsed = markdownToPage(text), id = useStore.getState().createPage(null, { title: title.trim() || parsed.title, icon: parsed.icon, blocks: sanitizeBlocks(parsed.blocks) }); onClose(); withViewTransition(() => router.push(`/p/${id}`)); };
  return <Modal title="Import Markdown" onClose={onClose}><div className="space-y-3 p-5"><input className="auth-input" placeholder="Page title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} /><textarea className="auth-input h-56 resize-none font-mono" placeholder="Paste Markdown here, or upload a .md file…" value={text} onChange={(e) => setText(e.target.value)} />{error && <p role="alert" className="danger text-xs">{error}</p>}<input ref={input} className="sr-only" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; try { setText(await file.text()); if (!title.trim()) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, "")); } catch { setError("Could not read that file."); } }} /><div className="flex justify-between"><button className="action-button" onClick={() => input.current?.click()}>Upload file</button><button className="action-button text-accent" disabled={!text.trim()} onClick={run}>Import</button></div></div></Modal>;
}
