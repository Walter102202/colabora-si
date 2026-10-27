"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox } from "lucide-react";
import { useStore } from "@/lib/store";
import { notificationHref, notificationText, useAgentNotifications } from "@/lib/agentNotifications";
import { useAgentTasks, waitingOnYou } from "@/lib/agentTasks";
import { formatRelative } from "@/lib/utils";

// Agent layer plug. Mounted in the topbar, right of the reminder bell. Counts
// what is waiting on the person: tasks that need a decision and unread
// notifications. Hidden without a session.
export function InboxBell() {
  const router = useRouter();
  const userId = useStore((s) => s.syncUserId);
  const subscribe = useAgentNotifications((s) => s.subscribe);
  const markRead = useAgentNotifications((s) => s.markRead);
  const notifications = useAgentNotifications((s) => s.notifications);
  const tasks = useAgentTasks((s) => s.tasks);
  const waiting = useMemo(() => waitingOnYou({ tasks } as Parameters<typeof waitingOnYou>[0]), [tasks]);
  const unread = useMemo(() => notifications.filter((n) => !n.read_at), [notifications]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!userId) return;
    return subscribe(userId);
  }, [userId, subscribe]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!userId) return null;
  const count = waiting.length + unread.length;

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="icon-button relative" aria-label={count ? `${count} waiting on you` : "Inbox"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Inbox size={17} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-white">{count > 99 ? "99+" : count}</span>
        )}
      </button>
      {open && (
        <div className="menu-panel absolute right-0 top-full z-30 mt-1 w-80 max-w-[90vw] p-2 text-sm">
          <p className="px-1 pb-1 text-xs font-medium text-text-secondary">Waiting on you</p>
          {waiting.length === 0 && unread.length === 0 && <p className="px-1 py-2 text-xs text-text-tertiary">Nothing waits on you.</p>}
          <ul className="max-h-80 space-y-0.5 overflow-auto">
            {waiting.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded px-2 py-1 text-left hover:bg-bg-secondary"
                  onClick={() => {
                    setOpen(false);
                    router.push(`/p/${encodeURIComponent(t.row_page_id)}?task=${encodeURIComponent(t.id)}`);
                  }}
                >
                  <span className="truncate">{t.title || "Untitled task"}</span>
                  <span className="text-xs text-text-tertiary">Needs your decision{t.last_activity_at ? ` · ${formatRelative(Date.parse(t.last_activity_at))}` : ""}</span>
                </button>
              </li>
            ))}
            {unread.map((n) => {
              const href = notificationHref(n);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start rounded px-2 py-1 text-left hover:bg-bg-secondary"
                    onClick={() => {
                      setOpen(false);
                      void markRead([n.id]);
                      if (href) router.push(href);
                    }}
                  >
                    <span className="truncate">{notificationText(n)}</span>
                    <span className="text-xs text-text-tertiary">{formatRelative(Date.parse(n.created_at))}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {unread.length > 0 && (
            <button type="button" className="mt-1 w-full rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-secondary" onClick={() => void markRead(unread.map((n) => n.id))}>
              Mark all as read
            </button>
          )}
        </div>
      )}
    </div>
  );
}
