import { chooseEntry, hasStoredSession } from "@/lib/landingEntry";

// Decides first, then loads one side: a landing visitor never downloads the Shell, the store or the editor.
const { pathname, search, hash } = location;
const hasBackend = Boolean(import.meta.env.VITE_SUPABASE_URL);
let hasSession = false;
try { hasSession = hasStoredSession(localStorage); } catch { /* blocked storage has no session */ }

if (chooseEntry({ pathname, search, hash, hasBackend, hasSession }) === "landing") void import("./landingEntry");
else void import("./workspaceEntry");
