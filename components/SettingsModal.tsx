"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AgentsSettingsTab } from "@/components/agents/AgentsSettingsTab";
import Modal from "@/components/Modal";
import { useStore } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@/lib/factories";
import { applyThemeMode, getThemeMode } from "@/lib/useTheme";
import { downloadBlob } from "@/lib/export";
import type { WorkspaceState } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { readZip, writeZip } from "@/lib/zip";
import { foreignPageIds } from "@/lib/foreignPages";
import { isSupabaseConfigured } from "@/lib/supabase";
import { forceFullPull, forceFullPush, useSyncStatus } from "@/lib/sync";
export function workspaceExport() {
  const s = useStore.getState();
  return { app: "colabora-si", version: 1, exportedAt: new Date().toISOString(), pages: Object.fromEntries(Object.entries(s.pages).filter(([id]) => !foreignPageIds.has(id))), rootOrder: s.rootOrder.filter((id) => !foreignPageIds.has(id)), expanded: s.expanded, syncedBlocks: s.syncedBlocks ?? {}, reminders: s.reminders ?? [], settings: s.settings };
}
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings) ?? DEFAULT_SETTINGS, pages = useStore((s) => s.pages), router = useRouter();
  const { user } = useAuth();
  const [tab, setTab] = useState("Appearance"), [theme, setTheme] = useState(getThemeMode), [error, setError] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const [storage] = useState(() => { let bytes = 0; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i)!; bytes += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2; } return `${(bytes / 1024).toFixed(1)} KB in localStorage`; });
  const update = useStore((s) => s.updateSettings), trash = Object.values(pages).filter((p) => p.isDeleted).length;
  return <Modal title="Settings" onClose={onClose} wide><div className="settings-layout"><nav aria-label="Settings sections">{["Account", "Members", "Agents", "Appearance", "Editor", "Data", "About"].map((name) => <button className={tab === name ? "active" : ""} key={name} onClick={() => setTab(name)}>{name}</button>)}</nav><div className="settings-content"><h3 className="mb-5 font-semibold">{tab}</h3>
    {tab === "Account" && <div className="space-y-4"><p className="text-sm text-text-secondary">{!isSupabaseConfigured() ? "Sync isn't configured for this build. The app keeps working fully offline — everything is stored in your browser." : user ? user.email : "Log in to sync your workspace across devices."}</p><button className="action-button" onClick={() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "auth" } }))}>{user ? "Manage account" : "Log in"}</button></div>}
    {tab === "Members" && <p className="text-sm text-text-secondary">Sign in to invite people</p>}{tab === "Agents" && <AgentsSettingsTab />}
    {tab === "Appearance" && <><fieldset><legend>Theme</legend><p>How the app looks on this device.</p><div className="segmented">{(["light", "dark", "system"] as const).map((mode) => <button key={mode} aria-pressed={theme === mode} onClick={() => { applyThemeMode(mode); setTheme(mode); update({ theme: mode }); }}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div></fieldset>
      <fieldset><legend>Default page font</legend><p>Applied to newly created pages.</p><div className="segmented">{(["default", "serif", "mono"] as const).map((font) => <button key={font} className={`font-page-${font}`} aria-pressed={settings.defaultFont === font} onClick={() => update({ defaultFont: font })}>{font[0].toUpperCase() + font.slice(1)}</button>)}</div></fieldset>
      <label className="setting-toggle">Small text by default<input type="checkbox" checked={settings.smallTextDefault} onChange={(e) => update({ smallTextDefault: e.target.checked })} /></label><label className="setting-toggle">Full width by default<input type="checkbox" checked={settings.fullWidthDefault} onChange={(e) => update({ fullWidthDefault: e.target.checked })} /></label></>}
    {tab === "Editor" && <fieldset><label className="setting-toggle">Spellcheck<input type="checkbox" checked={settings.spellcheck} onChange={(e) => update({ spellcheck: e.target.checked })} /></label><p>Underline misspelled words while typing.</p></fieldset>}
    {tab === "Data" && <><SyncControls /><fieldset><legend>Storage</legend><p>{Object.values(pages).filter((p) => !p.isDeleted).length} pages · {storage}</p></fieldset><fieldset><legend>Backup</legend><p>JSON holds pages only; the full backup .zip also carries every uploaded image and file.</p><div className="flex flex-wrap gap-2"><button className="action-button" onClick={() => downloadBlob(new Blob([JSON.stringify(workspaceExport(), null, 2)], { type: "application/json" }), "workspace-export.json")}>Export JSON</button><button className="action-button" disabled={backingUp} onClick={async () => { setBackingUp(true); setError(""); try { const blob = writeZip([{ name: "workspace.json", data: new TextEncoder().encode(JSON.stringify(workspaceExport(), null, 2)) }]); downloadBlob(blob, "workspace-backup.zip"); } catch { setError("Could not build the backup archive."); } finally { setBackingUp(false); } }}>{backingUp ? "Working…" : "Export full backup (.zip)"}</button><label className="action-button cursor-pointer">Import<input className="sr-only" type="file" accept="application/json,.json,application/zip,.zip" onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      try {
        let data;
        if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
          let entries; try { entries = await readZip(await file.arrayBuffer()); } catch { setError("Could not read that .zip backup."); return; }
          const workspace = entries.find((entry) => entry.name === "workspace.json");
          if (!workspace) { setError("That .zip has no workspace.json — not a full backup."); return; }
          data = JSON.parse(new TextDecoder().decode(workspace.data));
        } else data = JSON.parse(await file.text());
        if (!data || !data.pages || typeof data.pages !== "object" || Array.isArray(data.pages) || !Array.isArray(data.rootOrder) || !Object.values(data.pages).every((p) => p && typeof p === "object" && "id" in p && "title" in p && "blocks" in p && Array.isArray(p.blocks))) { setError("Not a valid workspace export file."); return; }
        if (confirm("Import this workspace? This REPLACES all current pages and settings.")) { useStore.getState().importWorkspace(data as WorkspaceState); onClose(); router.push("/"); }
      } catch { setError("Could not parse that file as JSON."); }
    }} /></label></div>{error && <p role="alert" className="danger">{error}</p>}</fieldset><fieldset><legend>Trash</legend><p>{trash ? `${trash} pages in trash.` : "Trash is empty."}</p><button className="action-button" disabled={!trash} onClick={() => { if (confirm("Permanently delete all pages in Trash?")) useStore.getState().emptyTrash(); }}>Empty trash</button></fieldset><fieldset><legend>Danger zone</legend><p>Deletes every page and starts over with the sample workspace.</p><button className="action-button danger" onClick={() => { if (confirm("Reset the entire workspace? This deletes all your pages.")) { useStore.getState().resetWorkspace(); onClose(); router.push("/"); } }}>Reset workspace</button></fieldset></>}
    {tab === "About" && <div className="space-y-4 text-sm text-text-secondary"><p><strong>colabora.si</strong> — a local-first workspace for humans and AI agents. Everything you write is stored in your browser.</p><p>Built with Next.js, React, Tailwind and Zustand.</p><p>Tip: press Ctrl/⌘ / for keyboard shortcuts.</p></div>}
  </div></div></Modal>;
}

function SyncControls() {
  const { user } = useAuth(), { status, lastSyncedAt } = useSyncStatus(), workspaceId = useStore((s) => s.syncWorkspaceId);
  const [busy, setBusy] = useState<"push" | "pull" | null>(null), [error, setError] = useState("");
  const configured = isSupabaseConfigured(), connected = !!user && !!workspaceId && status !== "idle";
  const labels = { idle: "Not syncing", syncing: "Syncing…", synced: "Up to date", offline: "Offline — changes queue locally", error: "Sync error — retrying" };
  const run = async (kind: "push" | "pull") => {
    setBusy(kind); setError("");
    try { if (kind === "push") await forceFullPush(); else await forceFullPull(); }
    catch { setError("Could not complete the sync — check your connection and try again."); }
    finally { setBusy(null); }
  };
  return <fieldset><legend>Sync</legend>{!configured ? <p>Sync isn&apos;t configured for this build — everything stays in your browser.</p> : !user ? <p>Not signed in — this workspace is local-only. Log in from the Account tab to sync it to the cloud.</p> : <><p>{new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host} · {labels[status]}{lastSyncedAt ? ` · last sync ${new Date(lastSyncedAt).toLocaleTimeString("en-US")}` : ""}</p><p className="break-all font-mono text-xs">Workspace: {workspaceId ?? "Connecting…"}</p><div className="flex flex-wrap gap-2"><button className="action-button" disabled={!connected || !!busy || status === "syncing" || status === "offline"} onClick={() => void run("push")}>{busy === "push" ? "Pushing…" : "Force full push"}</button><button className="action-button" disabled={!connected || !!busy || status === "syncing" || status === "offline"} onClick={() => void run("pull")}>{busy === "pull" ? "Pulling…" : "Force full pull"}</button></div>{error && <p role="alert" className="danger">{error}</p>}</>}</fieldset>;
}
