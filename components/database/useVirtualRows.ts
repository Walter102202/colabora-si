import { useEffect, useState, type RefObject } from "react";
import { ROW_HEIGHT_FALLBACK, VIRTUAL_OVERSCAN, windowRange } from "@/lib/virtualWindow";

export function useVirtualRows(tableRef: RefObject<HTMLTableElement | null>, total: number, enabled: boolean): { start: number; end: number; padTop: number; padBottom: number } {
  const [range, setRange] = useState({ start: 0, end: total, padTop: 0, padBottom: 0 });
  useEffect(() => {
    if (!enabled || !tableRef.current) return;
    const table = tableRef.current;
    let container = table.parentElement;
    while (container && (!["auto", "scroll"].includes(getComputedStyle(container).overflowY) || container.scrollHeight <= container.clientHeight)) container = container.parentElement;
    container ??= document.scrollingElement as HTMLElement | null;
    if (!container) return;
    const scroller = container, root = scroller === document.scrollingElement;
    const update = () => {
      const body = table.tBodies[0]; if (!body) return;
      const first = body.querySelector<HTMLTableRowElement>("tr:not([aria-hidden]):not(.database-group)");
      const rowHeight = first?.getBoundingClientRect().height || ROW_HEIGHT_FALLBACK;
      const top = root ? 0 : scroller.getBoundingClientRect().top;
      const next = windowRange(top - body.getBoundingClientRect().top, scroller.clientHeight, rowHeight, total, VIRTUAL_OVERSCAN);
      setRange((current) => current.start === next.start && current.end === next.end ? current : next);
    };
    const target = root ? window : scroller;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update); observer.observe(scroller);
    const frame = requestAnimationFrame(update);
    return () => { cancelAnimationFrame(frame); target.removeEventListener("scroll", update); window.removeEventListener("resize", update); observer.disconnect(); };
  }, [tableRef, total, enabled]);
  return enabled ? range : { start: 0, end: total, padTop: 0, padBottom: 0 };
}
