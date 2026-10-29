export const VIRTUAL_THRESHOLD = 200, VIRTUAL_OVERSCAN = 10, ROW_HEIGHT_FALLBACK = 34;
export function windowRange(scrollTop: number, viewportHeight: number, rowHeight: number, total: number, overscan: number): { start: number; end: number; padTop: number; padBottom: number } {
  if (rowHeight <= 0 || total === 0) return { start: 0, end: total, padTop: 0, padBottom: 0 };
  const top = Math.max(0, scrollTop);
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((top + viewportHeight) / rowHeight) + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (total - end) * rowHeight };
}
