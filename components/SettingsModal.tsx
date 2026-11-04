import { downloadGitExport } from "@/lib/gitExport";
import { Input } from "@/components/FormControls";
import type { SettingsTab } from "@/lib/routes";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { MemorySettingsTab } from "@/components/agents/MemorySettingsTab";
import { UsageSettingsTab } from "@/components/agents/UsageSettingsTab";
import { AgentsSettingsTab } from "@/components/agents/AgentsSettingsTab";
import Modal from "@/components/Modal";
import { useStore } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@/lib/factories";
import { applyThemeMode, getThemeMode } from "@/lib/useTheme";
import { downloadBlob } from "@/lib/export";
import type { WorkspaceState } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { cleanupUnusedFiles, getFile, referencedFileIds, putFile } from "@/lib/fileStore";
import { readZip, writeZip } from "@/lib/zip";
import { foreignPageIds } from "@/lib/foreignPages";
import { isSupabaseConfigured } from "@/lib/supabase";
import { finishBodyDownload, forceFullPull, forceFullPush, useSyncStatus } from "@/lib/sync";
import MembersSettings from "@/components/MembersSettings";
import PushSettings from "@/components/PushSettings";
import { readFullWorkspace } from "@/lib/localPersistence";
import { emptyTrashLoaded, importWorkspaceLoaded, resetWorkspaceLoaded } from "@/lib/pageBodies";
async function workspaceExport() {
  await finishBodyDownload();
  const { pages, missing } = await readFullWorkspace();
  if (missing) throw new Error(`${missing} pages aren't on this device yet. Stay online until they finish downloading, then export again.`);
  const s = useStore.getState();
  return { app: "colabora-si", version: 1, exportedAt: new Date().toISOString(), pages, rootOrder: s.rootOrder.filter((id) => !foreignPageIds.has(id)), expanded: s.expanded, syncedBlocks: s.syncedBlocks ?? {}, reminders: s.reminders ?? [], settings: s.settings };
}
export default function SettingsModal({ onClose, tab: selectedTab, onTabChange }: { onClose: () => void; tab: string; onTabChange: (tab: SettingsTab) => void }) {
  const settings = useStore((s) => s.settings) ?? DEFAULT_SETTINGS, pages = useStore((s) => s.pages), navigate = useNavigate();
  const { user } = useAuth();
  const tab = (selectedTab || "appearance")[0].toUpperCase() + (selectedTab || "appearance").slice(1);
  const [theme, setTheme] = useState(getThemeMode), [error, setError] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const [storage, setStorage] = useState("");
  useEffect(() => {
    let active = true;
    void navigator.storage?.estimate?.().then(({ usage }) => {
      if (active && usage !== undefined) setStorage(`${(usage / 1024 / 1024).toFixed(1)} MB on this device`);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const update = useStore((s) => s.updateSettings), trash = Object.values(pages).filter((p) => p.isDeleted).length;
  return <div className={tab === "Usage" ? "[&_.modal-wide]:w-[min(1200px,96vw)]!" : undefined}><Modal title="Settings" onClose={onClose} wide><div className="settings-layout"><nav aria-label="Settings sections">{["Account", "Members", "Agents", "Usage", "Memory", "Appearance", "Editor", "Data", "About"].map((name) => <button className={tab === name ? "active" : ""} key={name} onClick={() => onTabChange(name.toLowerCase() as SettingsTab)}>{name}</button>)}</nav><div className="settings-content">{tab !== "Usage" && <h3 className="mb-5 font-semibold">{tab}</h3>}
    {tab === "Account" && <div className="space-y-4"><p className="text-sm text-text-secondary">{!isSupabaseConfigured() ? "Sync isn't configured for this build. The app keeps working fully offline — everything is stored in your browser." : user ? user.email : "Log in to sync your workspace across devices."}</p><button className="action-button" onClick={() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "auth" } }))}>{user ? "Manage account" : "Log in"}</button><PushSettings /></div>}
    {tab === "Members" && <MembersSettings />}{tab === "Agents" && <AgentsSettingsTab />}{tab === "Usage" && <UsageSettingsTab />}{tab === "Memory" && <MemorySettingsTab />}
    {tab === "Appearance" && <><fieldset><legend>Theme</legend><p>How the app looks on this device.</p><div className="segmented">{(["light", "dark", "system"] as const).map((mode) => <button key={mode} aria-pressed={theme === mode} onClick={() => { applyThemeMode(mode); setTheme(mode); update({ theme: mode }); }}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div></fieldset>
      <fieldset><legend>Default page font</legend><p>Applied to newly created pages.</p><div className="segmented">{(["default", "serif", "mono"] as const).map((font) => <button key={font} className={`font-page-${font}`} aria-pressed={settings.defaultFont === font} onClick={() => update({ defaultFont: font })}>{font[0].toUpperCase() + font.slice(1)}</button>)}</div></fieldset>
      <div className="setting-toggle">Small text by default<Input label="Small text by default" type="checkbox" checked={settings.smallTextDefault} onChange={(e) => update({ smallTextDefault: e.target.checked })} /></div><div className="setting-toggle">Full width by default<Input label="Full width by default" type="checkbox" checked={settings.fullWidthDefault} onChange={(e) => update({ fullWidthDefault: e.target.checked })} /></div></>}
    {tab === "Editor" && <fieldset><div className="setting-toggle">Spellcheck<Input label="Spellcheck" type="checkbox" checked={settings.spellcheck} onChange={(e) => update({ spellcheck: e.target.checked })} /></div><p>Underline misspelled words while typing.</p></fieldset>}
    {tab === "Data" && <><SyncControls /><fieldset><legend>Storage</legend><button className="action-button" onClick={async () => { try { const result = await cleanupUnusedFiles(); setError("Removed " + result.deleted + " unused files (" + (result.bytes / 1024).toFixed(1) + " KB)."); } catch (error) { setError(error instanceof Error && error.message === "pages_not_on_device" ? "Some pages aren't on this device yet. Stay online until they finish downloading, then try again." : "Could not clean up files."); } }}>Clean up unused files</button><p>{Object.values(pages).filter((p) => !p.isDeleted).length} pages{storage && ` · ${storage}`}</p></fieldset><fieldset><legend>Backup</legend><p>JSON holds pages only; the full backup .zip also carries every uploaded image and file. The Markdown archive is a one-way export for file-based tools.</p><div className="flex flex-wrap gap-2"><button className="action-button" onClick={async () => { setError(""); try { downloadBlob(new Blob([JSON.stringify(await workspaceExport(), null, 2)], { type: "application/json" }), "workspace-export.json"); } catch (error) { setError(error instanceof Error ? error.message : "Could not build the backup."); } }}>Export JSON</button><button className="action-button" disabled={backingUp} onClick={async () => { setBackingUp(true); setError(""); try { const snapshot = await workspaceExport(); const entries = [{ name: "workspace.json", data: new TextEncoder().encode(JSON.stringify(snapshot, null, 2)) }]; for (const id of referencedFileIds(snapshot.pages, snapshot.syncedBlocks)) { const blob = await getFile(id).catch(() => undefined); if (blob) entries.push({ name: "files/" + id, data: new Uint8Array(await blob.arrayBuffer()) }); } const blob = writeZip(entries); downloadBlob(blob, "workspace-backup.zip"); } catch (error) { setError(error instanceof Error ? error.message : "Could not build the backup archive."); } finally { setBackingUp(false); } }}>{backingUp ? "Working…" : "Export full backup (.zip)"}</button><button className="action-button" onClick={async () => { setError(""); try { const snapshot = await workspaceExport(); downloadGitExport(snapshot.pages, foreignPageIds); } catch (error) { setError(error instanceof Error ? error.message : "Could not build the Markdown archive."); } }}>Export Markdown (.zip)</button><div className="action-button cursor-pointer"><Input label="Import" labelClassName="cursor-pointer" className="sr-only" type="file" accept="application/json,.json,application/zip,.zip" onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      try {
        let data;
        if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
          let entries; try { entries = await readZip(await file.arrayBuffer()); } catch { setError("Could not read that .zip backup."); return; }
          const workspace = entries.find((entry) => entry.name === "workspace.json");
          if (!workspace) { setError("That .zip has no workspace.json — not a full backup."); return; }
          data = JSON.parse(new TextDecoder().decode(workspace.data));
          for (const entry of entries) if (!entry.dir && entry.name.startsWith("files/") && entry.name.length > 6) await putFile(entry.name.slice(6), new Blob([entry.data.slice().buffer])).catch(() => {});
        } else data = JSON.parse(await file.text());
        if (!data || !data.pages || typeof data.pages !== "object" || Array.isArray(data.pages) || !Array.isArray(data.rootOrder) || !Object.values(data.pages).every((p) => p && typeof p === "object" && "id" in p && "title" in p && "blocks" in p && Array.isArray(p.blocks))) { setError("Not a valid workspace export file."); return; }
        if (confirm("Import this workspace? This REPLACES all current pages and settings.")) { if (await importWorkspaceLoaded(data as WorkspaceState)) { onClose(); navigate("/"); } }
      } catch { setError("Could not parse that file as JSON."); }
    }} /></div></div>{error && <p role="alert" className="danger">{error}</p>}</fieldset><fieldset><legend>Trash</legend><p>{trash ? `${trash} pages in trash.` : "Trash is empty."}</p><button className="action-button" disabled={!trash} onClick={() => { if (confirm("Permanently delete all pages in Trash?")) void emptyTrashLoaded(); }}>Empty trash</button></fieldset><fieldset><legend>Danger zone</legend><p>Deletes every page and starts over with the sample workspace.</p><button className="action-button danger" onClick={() => { if (confirm("Reset the entire workspace? This deletes all your pages.")) { void resetWorkspaceLoaded().then((reset) => { if (reset) { onClose(); navigate("/"); } }); } }}>Reset workspace</button></fieldset></>}
    {tab === "About" && <div className="space-y-4 text-sm text-text-secondary"><p><strong>colabora.si</strong> · 0.1.0 — a local-first workspace for humans and AI agents. Everything you write is stored in your browser.</p><p>Built with Next.js, React, Tailwind and Zustand.</p><p>Tip: press Ctrl/⌘ / for keyboard shortcuts.</p></div>}
  </div></div></Modal></div>;
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
  return <fieldset><legend>Sync</legend>{!configured ? <p>Sync isn&apos;t configured for this build — everything stays in your browser.</p> : !user ? <p>Not signed in — this workspace is local-only. Log in from the Account tab to sync it to the cloud.</p> : <><p>{new URL(import.meta.env.VITE_SUPABASE_URL!).host} · {labels[status]}{lastSyncedAt ? ` · last sync ${new Date(lastSyncedAt).toLocaleTimeString("en-US", { timeZone: "UTC" })}` : ""}</p><p className="break-all font-mono text-xs">Workspace: {workspaceId ?? "Connecting…"}</p><div className="flex flex-wrap gap-2"><button className="action-button" disabled={!connected || !!busy || status === "syncing" || status === "offline"} onClick={() => void run("push")}>{busy === "push" ? "Pushing…" : "Force full push"}</button><button className="action-button" disabled={!connected || !!busy || status === "syncing" || status === "offline"} onClick={() => void run("pull")}>{busy === "pull" ? "Pulling…" : "Force full pull"}</button></div>{error && <p role="alert" className="danger">{error}</p>}</>}</fieldset>;
}
