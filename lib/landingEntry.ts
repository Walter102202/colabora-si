import { LANDING_URL } from "@/lib/routes";

export type Entry = "landing" | "workspace";

export interface EntryInput {
  pathname: string;
  search: string;
  hash: string;
  hasBackend: boolean;
  hasSession: boolean;
}

// Query parameters the app must handle: invitations, modal state and auth callbacks.
const APP_QUERY = ["invite", "settings", "search", "peek", "modal", "code", "token_hash", "error"];
const AUTH_HASH = ["access_token", "error"];
const AUTH_TOKEN_KEY = /^sb-.+-auth-token$/;

// Decided before any workspace code loads, so a visitor never downloads the app. Without a
// backend the workspace is the whole product, so "/" stays the workspace there.
export function chooseEntry({ pathname, search, hash, hasBackend, hasSession }: EntryInput): Entry {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === LANDING_URL) return "landing";
  if (path !== "/" || !hasBackend || hasSession) return "workspace";
  const query = new URLSearchParams(search);
  if (APP_QUERY.some((name) => query.has(name))) return "workspace";
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  return AUTH_HASH.some((name) => fragment.has(name)) ? "workspace" : "landing";
}

// supabase-js keeps the session in localStorage. Reading the key avoids loading the client here.
export function hasStoredSession(storage: Pick<Storage, "length" | "key" | "getItem">): boolean {
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && AUTH_TOKEN_KEY.test(key) && storage.getItem(key)) return true;
    }
  } catch {
    // Blocked storage has no session to find.
  }
  return false;
}
