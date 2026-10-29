export type SettingsTab = "account" | "members" | "agents" | "appearance" | "editor" | "data" | "about";
export interface PageLinkOptions { task?: string; peek?: string; }
export const HOME_URL = "/";
export const LINKED_URL = "/linked";
export const MCP_PAT_URL = "/mcp-pat";

// Pure URL constructors shared by the SPA and clients that generate deep links.
export function withQuery(path: string, values: Record<string, string | null | undefined>): string {
  const url = new URL(path, "https://colabora.si");
  for (const [key, value] of Object.entries(values)) {
    if (value == null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return url.pathname + url.search + url.hash;
}
export function pageUrl(id: string, options: PageLinkOptions = {}): string {
  return withQuery(`/p/${encodeURIComponent(id)}`, { ...options });
}
export function taskUrl(pageId: string, taskId: string): string { return pageUrl(pageId, { task: taskId }); }
export function sharedUrl(id: string): string { return `/shared/${encodeURIComponent(id)}`; }
export function pubUrl(id: string): string { return `/pub/${encodeURIComponent(id)}`; }
export function settingsUrl(tab: SettingsTab = "appearance", path = HOME_URL): string { return withQuery(path, { settings: tab, modal: null, search: null }); }
export function searchUrl(query = "", path = HOME_URL): string { return withQuery(path, { search: query, modal: null, settings: null }); }
export function peekUrl(id: string | null, path = HOME_URL): string { return withQuery(path, { peek: id }); }
