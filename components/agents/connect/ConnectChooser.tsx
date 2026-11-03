import { Bot } from "lucide-react";
import type { ConnectCatalogEntry } from "@/lib/agentConnectCatalog";
import { ConnectNotice } from "./ConnectNotice";

export function ConnectChooser({ catalog, onChoose }: { catalog: ConnectCatalogEntry[]; onChoose: (id: string) => void }) {
  return <>
    <div className="text-center">
      <h1 className="mb-2 text-[34px] font-bold leading-tight">Connect your agent</h1>
      <p className="mb-11 text-text-secondary">Work on shared pages with the agent you already use.</p>
      <h2 id="connect-choice" className="mb-4 text-[15px] font-semibold">Which agent do you use?</h2>
    </div>
    <div role="group" aria-labelledby="connect-choice" className="grid grid-cols-[repeat(auto-fit,minmax(136px,1fr))] gap-3">
      {catalog.map((entry) => <button key={entry.id} type="button" aria-label={`Connect with ${entry.name}`} onClick={() => onChoose(entry.id)}
        className={`flex min-h-[116px] flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-bg px-2 py-4 text-sm font-medium transition-colors hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${entry.route === "own" ? "col-span-full" : ""}`}>
        <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-lg bg-white">
          {entry.route === "own" ? <Bot size={26} className="text-neutral-700" /> : <img src={entry.logo} alt="" width={36} height={36} className="h-9 w-9 object-contain" />}
        </span>
        <span>{entry.name}</span>
      </button>)}
    </div>
    <p className="mt-7 text-center text-sm text-text-secondary">You’ll review its access before it connects.</p>
    <p className="mt-2 text-center text-sm"><a href="/connect.md" className="text-accent hover:underline">Other agents and setup help</a></p>
    <ConnectNotice />
  </>;
}
