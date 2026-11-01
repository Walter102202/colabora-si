import { useEffect, useState } from "react";
import { ensurePageBodies } from "@/lib/pageBodies";
import { isShell } from "@/lib/pageShell";
import { useStore } from "@/lib/store";
import { useSyncStatus } from "@/lib/sync";

export function usePageBodies(ids: string[]): "ready" | "loading" | "unavailable" {
  const key = JSON.stringify(ids), status = useSyncStatus((state) => state.status);
  const shells = useStore((state) => ids.some((id) => isShell(state.pages[id])));
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!shells) return;
    let active = true;
    void ensurePageBodies(JSON.parse(key) as string[]).then((result) => { if (active) setFailed(result === "unavailable" ? key : null); });
    return () => { active = false; };
  }, [key, shells, status]);
  if (!shells) return "ready";
  return failed === key && status !== "syncing" ? "unavailable" : "loading";
}
