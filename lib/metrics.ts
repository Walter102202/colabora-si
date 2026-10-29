import type { Page } from "@/lib/types";

export function pageDataSizes(pages: Record<string, Page>): { count: number; totalBytes: number; p95Bytes: number; largest: { id: string; title: string; bytes: number }[] } {
  const encoder = new TextEncoder();
  const sizes = Object.values(pages).map((page) => ({ id: page.id, title: page.title, bytes: encoder.encode(JSON.stringify(page)).byteLength })).sort((a, b) => a.bytes - b.bytes);
  return { count: sizes.length, totalBytes: sizes.reduce((sum, page) => sum + page.bytes, 0), p95Bytes: sizes[Math.ceil(sizes.length * 0.95) - 1]?.bytes ?? 0, largest: sizes.slice(-5).reverse() };
}
export function mark(name: string): void { if (typeof performance !== "undefined") performance.mark(name); }
export function measureSince(name: string, startMark: string): number | null {
  if (typeof performance === "undefined") return null;
  try { return performance.measure(name, startMark).duration; } catch { return null; }
}
let hydration: ReturnType<typeof pageDataSizes> | undefined;
export function recordHydration(sizes: ReturnType<typeof pageDataSizes>): void { hydration = sizes; }
export function reportStartup(extra: Record<string, unknown> = {}): void {
  if (!import.meta.env.DEV || typeof performance === "undefined") return;
  const rows: { metric: string; value: unknown }[] = performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("colabora:")).map((entry) => ({ metric: entry.name, value: entry.duration }));
  const hydrated = performance.getEntriesByName("colabora:hydrate:end").at(-1);
  if (hydrated) rows.push({ metric: hydrated.name, value: hydrated.startTime });
  for (const [metric, value] of Object.entries({ ...hydration, ...extra })) rows.push({ metric, value: typeof value === "object" ? JSON.stringify(value) : value });
  console.table(rows);
}
