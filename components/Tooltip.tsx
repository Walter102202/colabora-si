import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function Tooltip({ children, label, shortcut, delay = 400 }: { children: React.ReactNode; label: string; shortcut?: string; delay?: number }) {
  const id = useId(), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = () => { if (timer.current) clearTimeout(timer.current); setPosition(null); };
  useEffect(() => {
    const hide = () => setPosition(null);
    window.addEventListener("scroll", hide, true); window.addEventListener("resize", hide); window.addEventListener("blur", hide);
    return () => { if (timer.current) clearTimeout(timer.current); window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); window.removeEventListener("blur", hide); };
  }, []);
  return <span role="presentation" className="inline-flex" aria-describedby={position ? id : undefined} onMouseEnter={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    timer.current = setTimeout(() => setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 220)), top: rect.bottom + 6 > window.innerHeight - 32 ? rect.top - 32 : rect.bottom + 6 }), delay);
  }} onMouseLeave={close} onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPosition({ left: rect.left, top: rect.bottom + 6 }); }} onBlur={close}>
    {children}{position && createPortal(<span id={id} role="tooltip" className="tooltip" style={position}>{label}{shortcut && <span className="ml-2 opacity-60">{shortcut}</span>}</span>, document.body)}
  </span>;
}
