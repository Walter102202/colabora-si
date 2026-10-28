import { Cloud, CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useSyncStatus } from "@/lib/sync";
export default function SyncStatus() {
  const { status, error } = useSyncStatus();
  const title = { idle: "", synced: "Synced", syncing: "Syncing…", offline: "Offline — changes will sync when you reconnect", error: "Sync error — retrying" }[status];
  return <span className={`flex h-5 items-center gap-1.5 text-xs ${status === "error" ? "danger" : "text-text-tertiary"}`} title={error ? `${title}: ${error}` : title} role="status" aria-label={title || "Local workspace"}>{status === "synced" ? <Cloud size={13} /> : status === "syncing" ? <RefreshCw size={13} className="animate-spin" /> : status === "offline" ? <CloudOff size={13} /> : status === "error" ? <TriangleAlert size={13} /> : null}{title}</span>;
}
