import { useLayoutEffect, useState, type RefObject } from "react";
import { ROW_HEIGHT_FALLBACK, VIRTUAL_OVERSCAN, windowRange } from "@/lib/virtualWindow";

// Until the scroller is measured, a viewport of this many pixels with fallback row heights decides how many rows the first
// render mounts; the layout effect below measures before the first paint, so a large table never paints every row.
const INITIAL_VIEWPORT_PX = 800;
// One row height for every item: group headers and cells that wrap taller than the measured row drift the spacer math by
// their difference until the next scroll event recomputes the window.
export function useVirtualRows(tableRef: RefObject<HTMLTableElement | null>, total: number, enabled: boolean): { start: number; end: number; padTop: number; padBottom: number } {
  const [range, setRange] = useState(() => windowRange(0, INITIAL_VIEWPORT_PX, ROW_HEIGHT_FALLBACK, total, VIRTUAL_OVERSCAN));
  useLayoutEffect(() => {
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
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update); observer?.observe(scroller);
    update();
    return () => { target.removeEventListener("scroll", update); window.removeEventListener("resize", update); observer?.disconnect(); };
  }, [tableRef, total, enabled]);
  if (!enabled) return { start: 0, end: total, padTop: 0, padBottom: 0 };
  const end = Math.min(range.end, total); // the rows may have shrunk since the last measurement
  return { start: Math.min(range.start, end), end, padTop: range.padTop, padBottom: range.padBottom };
}
