import { Input } from "@/components/FormControls";
import { useState } from "react";
import { Link as LinkIcon } from "lucide-react";
import type { Block } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import { safeHref } from "@/lib/utils";
export default function BookmarkBlock({ block, ops }: { block: Block; ops: BlockOps }) {
  const [url, setUrl] = useState("");
  let host = block.url ?? ""; try { host = new URL(host).hostname; } catch {}
  return block.url ? <a className="bookmark-block" href={safeHref(block.url)} target="_blank" rel="noopener noreferrer"><LinkIcon size={18} /><span className="min-w-0"><strong className="block truncate text-sm">{block.bookmarkTitle || block.url}</strong><span className="text-xs text-text-secondary">{host}</span></span></a> : <form className="media-prompt" onSubmit={(e) => { e.preventDefault(); if (url.trim()) ops.updateBlock(block.id, { url: url.trim(), bookmarkTitle: url.trim() }); }}><p>Create a bookmark</p><div className="mt-2 flex gap-2"><Input label="Paste a link…" className="min-w-0 flex-1" placeholder="Paste a link…" value={url} onChange={(e) => setUrl(e.target.value)} readOnly={ops.locked} /><button className="action-button" disabled={ops.locked || !url.trim()}>Create</button></div></form>;
}
