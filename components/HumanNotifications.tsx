"use client";
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { markNotificationsRead, useNotifications } from "@/lib/notifications";
import { useStore } from "@/lib/store";
import { stripHtml, formatRelative } from "@/lib/utils";
const kinds: Record<string, string> = { mention: "You were mentioned", comment_reply: "New reply", share: "A page was shared with you", invite: "Workspace invitation" };
export default function HumanNotifications() {
  const items = useNotifications((s) => s.items).filter((item) => kinds[item.kind]), [open, setOpen] = useState(false), [error, setError] = useState(""), router = useRouter(), pages = useStore((s) => s.pages), unread = items.filter((item) => !item.read_at);
  return <div className="relative"><button className="icon-button relative" aria-label="Activity" title="Activity" onClick={() => setOpen(!open)}><MessageSquare size={17} />{!!unread.length && <span className="reminder-count">{unread.length}</span>}</button>{open && <><button className="menu-backdrop" aria-label="Close activity" onClick={() => setOpen(false)} /><div className="reminder-menu menu-panel"><h2 className="section-label">Activity</h2>{!items.length && <p className="p-2 text-xs text-text-tertiary">No notifications yet.</p>}{!!unread.length && <button onClick={() => void markNotificationsRead(unread.map((i) => i.id)).catch(() => setError("Could not mark notifications as read."))}>Mark all as read</button>}{items.map((item) => <button className="block w-full border-b border-border p-2 text-left" key={item.id} onClick={async () => { try { await markNotificationsRead([item.id]); } catch { setError("Could not mark notification as read."); return; } setOpen(false); if (item.page_id) router.push((pages[item.page_id] ? "/p/" : "/shared/") + item.page_id); }}><strong className="block text-xs">{!item.read_at && "● "}{kinds[item.kind]}</strong><span className="block truncate text-sm">{stripHtml(item.payload.body ?? "")}</span><small className="text-text-tertiary">{formatRelative(Date.parse(item.created_at))}</small></button>)}{error && <p role="alert" className="danger">{error}</p>}</div></>}</div>;
}
