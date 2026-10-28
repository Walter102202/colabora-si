import { useDirectory } from "@/lib/directory";
import type { Page } from "@/lib/types";
import { isoLocalDate } from "@/lib/datePicker";
export type MentionItem = { kind: "person"; id: string; title: string; isAgent: boolean } | { kind: "page"; id: string; title: string; icon: string | null } | { kind: "date"; label: string; iso: string } | { kind: "pickDate" };
export function filteredMentions(pages: Record<string, Page>, pageId: string, query: string): MentionItem[] {
  const q = query.toLowerCase(), items: MentionItem[] = Object.values(pages).filter((p) => !p.isDeleted && p.id !== pageId && (p.title || "Untitled").toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7).map((p) => ({ kind: "page", id: p.id, title: p.title || "Untitled", icon: p.icon }));
  items.push(...useDirectory.getState().entries.filter((p) => p.display_name.toLowerCase().includes(q)).slice(0, 7).map((p): MentionItem => ({ kind: "person", id: p.user_id, title: p.display_name, isAgent: p.is_agent })));
  for (const [name, delta] of [["Today", 0], ["Tomorrow", 1], ["Yesterday", -1]] as const) {
    if (!q || name.toLowerCase().includes(q)) { const date = new Date(); date.setDate(date.getDate() + delta); items.push({ kind: "date", label: `${name} · ${date.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })}`, iso: isoLocalDate(date) }); }
  }
  if (!q || ["date", "pick", "calendar"].some((word) => word.includes(q))) items.push({ kind: "pickDate" });
  return items;
}
