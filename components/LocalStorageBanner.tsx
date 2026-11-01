import { useNavigate } from "react-router";
import { flushLocalWrites, useLocalHealth } from "@/lib/localPersistence";
import { settingsUrl } from "@/lib/routes";
import { isSupabaseConfigured } from "@/lib/supabase";

const TEXT = {
  unavailable: "This browser isn't keeping a local copy. Your changes stay in this tab until you close it.",
  full: "Browser storage is full. Recent changes are only in this tab.",
  failing: "Changes can't be saved to this browser right now. Trying again…",
};
export default function LocalStorageBanner() {
  const health = useLocalHealth((state) => state.health), navigate = useNavigate();
  if (health === "starting" || health === "ok") return null;
  return <div role="alert" className="shrink-0 border-b border-border bg-bg-secondary px-4 py-3 text-sm">
    <p>{TEXT[health]}{health === "unavailable" && isSupabaseConfigured() && " Anything already synced is safe in the cloud."}</p>
    {(health === "full" || health === "unavailable") && <button className="action-button mt-2" onClick={() => { void navigate(settingsUrl("data")); }}>Export backup</button>}
    {health === "full" && <button className="action-button ml-2 mt-2" onClick={() => { void flushLocalWrites().catch(() => {}); }}>Try again</button>}
  </div>;
}
