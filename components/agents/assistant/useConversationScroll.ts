"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PersonMessage } from "@/lib/agentConversation";

const END_THRESHOLD = 48;
const nearEnd = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop <= END_THRESHOLD;

// Follow the conversation until the person scrolls back; explicit sends resume following.
export function useConversationScroll(messages: PersonMessage[], scrollRequest = 0) {
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const previousRequest = useRef(scrollRequest);
  const previousThread = useRef<{ firstId: string; workspaceId: string; count: number } | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const scrollToLatest = useCallback(() => {
    following.current = true;
    const element = listRef.current;
    if (element) {
      // An instant element scroll also respects reduced motion and never moves the workspace.
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
    }
    setShowScrollToLatest(false);
  }, []);

  const onScroll = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    if (nearEnd(element)) following.current = true;
    // Content growth can emit a scroll event at the same position before ResizeObserver runs.
    // Only an upward move away from the end means the person has stopped following.
    else if (element.scrollTop < lastTop.current - 1) following.current = false;
    lastTop.current = element.scrollTop;
    setShowScrollToLatest(!following.current);
  }, []);

  const syncLayout = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    if (following.current) scrollToLatest();
    else {
      following.current = nearEnd(element);
      lastTop.current = element.scrollTop;
      setShowScrollToLatest(!following.current);
    }
  }, [scrollToLatest]);

  useLayoutEffect(() => {
    const previous = previousThread.current;
    const first = messages[0];
    const replaced = !previous || !first || first.workspace_id !== previous.workspaceId
      || messages.length < previous.count || !messages.some((message) => message.id === previous.firstId);
    if (replaced || scrollRequest !== previousRequest.current) following.current = true;
    previousRequest.current = scrollRequest;
    previousThread.current = first ? { firstId: first.id, workspaceId: first.workspace_id, count: messages.length } : null;
    syncLayout();
  }, [messages, scrollRequest, syncLayout]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncLayout);
      return () => window.removeEventListener("resize", syncLayout);
    }
    const observer = new ResizeObserver(syncLayout);
    observer.observe(list);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [syncLayout]);

  return { listRef, contentRef, onScroll, scrollToLatest, showScrollToLatest };
}
