"use client";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
export default function Modal({ title, children, onClose, wide = false, dismissible = true }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; dismissible?: boolean }) {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input,button,select,textarea,[tabindex="0"]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]') ?? []);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [dismissible]);
  return <div className="modal-overlay" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose(); }}><div ref={panel} className={`modal-panel ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-header"><h2>{title}</h2>{dismissible && <button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={18} /></button>}</div>{children}
  </div></div>;
}
