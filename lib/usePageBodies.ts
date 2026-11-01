import { useEffect, useState } from "react";
import { backlinkIds, ensurePageBodies } from "@/lib/pageBodies";
import { isShell } from "@/lib/pageShell";
import { useStore } from "@/lib/store";
import { useSyncStatus } from "@/lib/sync";
import type { Page } from "@/lib/types";

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

export function useBacklinks(pageId: string): Page[] {
  const pages = useStore((state) => state.pages), [result, setResult] = useState<{ pageId: string; ids: string[] }>({ pageId: "", ids: [] });
  useEffect(() => {
    let active = true;
    // Let the normal write window coalesce typing before refreshing the index.
    const timer = setTimeout(() => {
      void backlinkIds(pageId).then((ids) => { if (active) setResult({ pageId, ids }); }).catch(() => {});
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [pageId, pages]);
  return (result.pageId === pageId ? result.ids : []).map((id) => pages[id]).filter((page) => page && !page.isDeleted && page.id !== pageId);
}
