import { useEffect, useRef, useState } from "react";

export const APPROVAL_RING_MS = 2000;

// A deep link `#approval-<id>` lands on one card: it scrolls into view, shows a
// ring for a moment and hands keyboard focus to its first control. Pure of
// routing: the connector decides which approval the link names.
export function useApprovalFocus(focus: boolean, approvalId: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [ring, setRing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!focus || !el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    el.querySelector<HTMLElement>("button:not(:disabled), textarea:not(:disabled)")?.focus();
    setRing(true);
    const timer = setTimeout(() => setRing(false), APPROVAL_RING_MS);
    return () => clearTimeout(timer);
  }, [focus, approvalId]);
  return { ref, id: `approval-${approvalId}`, ringClass: ring ? " ring-2 ring-accent" : "" };
}
