import { useEffect, useMemo } from "react";
import { DiscrepancyCard } from "@/components/agents/panel/DiscrepancyCard";
import { HomeCards } from "@/components/agents/panel/HomeCards";
import { openDiscrepancies, resolveDiscrepancy, useAgentSources } from "@/lib/agentSources";
import { pageUrl } from "@/lib/routes";
import { useStore } from "@/lib/store";

// Pages that disagree with a source and wait for a person. DecisionsHome mounts it above the task sections.
export function DiscrepanciesHome({ workspaceId }: { workspaceId: string }) {
  const discrepancies = useAgentSources((s) => s.discrepancies);
  const subscribe = useAgentSources((s) => s.subscribe);
  const pages = useStore((s) => s.pages);
  useEffect(() => subscribe(workspaceId), [subscribe, workspaceId]);
  const open = useMemo(() => openDiscrepancies(discrepancies), [discrepancies]);
  return <HomeCards title="Differences to settle" items={open.map((d) => (
    <DiscrepancyCard key={d.id} discrepancy={d} pageTitle={pages[d.page_id]?.title || "Untitled"} href={pageUrl(d.page_id)}
      onResolve={async (resolution, note) => { await resolveDiscrepancy(d.id, resolution, note); }} />
  ))} />;
}
