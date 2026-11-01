import { useState } from "react";
import { Link } from "react-router";
import { Plug, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { useAuthStore } from "@/lib/auth";
import { isConnectCardHidden, setConnectCardHidden, useConnectEligibility } from "@/lib/agentConnect";
import { CONNECT_URL } from "@/lib/routes";

export function ConnectHomeCard() {
  const workspaceId = useStore((state) => state.syncWorkspaceId), userId = useAuthStore((state) => state.user?.id);
  const eligibility = useConnectEligibility(), [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (!workspaceId || !userId || eligibility.key !== `${userId}:${workspaceId}` || !eligibility.canConnect || eligibility.hasVerified || hiddenFor === workspaceId || isConnectCardHidden(workspaceId)) return null;
  return <section className="mb-10 flex items-start gap-4 rounded-xl border border-border bg-bg-secondary p-5">
    <Plug aria-hidden="true" className="mt-1 shrink-0 text-accent" />
    <div className="min-w-0 flex-1"><h2 className="font-semibold">Connect your agent</h2><p className="mt-1 text-sm text-text-secondary">Work on shared pages with the agent you already use.</p><Link to={CONNECT_URL} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white">Connect an agent</Link></div>
    <button type="button" aria-label="Hide this card" className="icon-button shrink-0" onClick={() => { setConnectCardHidden(workspaceId); setHiddenFor(workspaceId); }}><X size={16} /></button>
  </section>;
}
