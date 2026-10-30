import { useEffect, useRef, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { useDirectory } from "@/lib/directory";
import CommentComposer from "@/components/CommentComposer";
import { formatRelative, sanitizeHtml } from "@/lib/utils";
import type { PageComment } from "@/lib/types";
const EMPTY_COMMENTS: PageComment[] = [];
export function CommentThread({ pageId, blockId, focusOnMount = false }: { pageId: string; blockId?: string; focusOnMount?: boolean }) {
  const comments = useStore((s) => s.pages[pageId]?.comments ?? EMPTY_COMMENTS), members = useStore((s) => s.members), agents = useStore((s) => s.agents);
  const workspaceId = useStore((s) => s.syncWorkspaceId), directory = useDirectory((s) => s.entries);
  const [showResolved, setShowResolved] = useState(false);
  const thread = comments.filter((c) => (c.anchorId ?? c.blockId) === blockId), open = thread.filter((c) => !c.resolved), resolved = thread.filter((c) => c.resolved);
  const author = (comment: PageComment) => {
    if (comment.authorType === "agent") return directory.find((a) => a.workspace_id === workspaceId && a.is_agent && a.user_id === comment.authorId)?.display_name
      || agents?.find((a) => a.id === comment.authorId)?.name
      || (comment.author && !/@agents\.invalid$/i.test(comment.author) ? comment.author : "Agent");
    return comment.author || members?.find((a) => a.id === comment.authorId)?.name || (comment.authorId === "local" ? "You (this device)" : comment.authorId);
  };
  return <section className="comment-thread"><h3 className="mb-3 text-xs uppercase text-text-tertiary">Comments{open.length ? ` · ${open.length}` : ""}</h3>{[...open, ...(showResolved ? resolved : [])].map((comment) => <div className="comment-row" key={comment.id}><span className="comment-avatar">{comment.authorType === "agent" ? "🤖" : "🙂"}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-xs text-text-tertiary"><span>{author(comment)}</span>{comment.authorType === "agent" && <span className="agent-badge">Agent</span>}<span>· {formatRelative(comment.createdAt)}</span><div className="hover-actions ml-auto flex"><button className="icon-button" aria-label={comment.resolved ? "Reopen comment" : "Resolve comment"} onClick={() => useStore.getState().toggleResolveComment(pageId, comment.id)}><Check size={14} /></button><button className="icon-button danger" aria-label="Delete comment" onClick={() => useStore.getState().deleteComment(pageId, comment.id)}><Trash2 size={14} /></button></div></div><p className={`whitespace-pre-wrap break-words text-sm ${comment.resolved ? "line-through text-text-tertiary" : ""}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.body) }} /></div></div>)}
    {!open.length && <p className="mb-3 text-xs text-text-tertiary">{blockId ? "No comments on this block yet." : "No comments yet."}</p>}
    <CommentComposer focusOnMount={focusOnMount} onSend={(body) => useStore.getState().addComment(pageId, body, blockId)} />
    {!!resolved.length && <button className="mt-2 text-xs text-text-tertiary" onClick={() => setShowResolved(!showResolved)}>{showResolved ? "Hide" : "Show"} {resolved.length} resolved</button>}
  </section>;
}
export default function BlockCommentsPopover({ pageId, blockId, rect, onClose }: { pageId: string; blockId: string; rect: DOMRect; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const outside = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(); }; const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; document.addEventListener("mousedown", outside); document.addEventListener("keydown", key); return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key); }; }, [onClose]);
  return <div ref={panel} className="menu-panel fixed z-[70] max-h-80 w-80 overflow-y-auto p-3" role="dialog" aria-label="Block comments" style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)), top: rect.bottom + 320 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - 326) }}><CommentThread pageId={pageId} blockId={blockId} focusOnMount /></div>;
}
