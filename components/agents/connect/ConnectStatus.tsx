import type { ConnectCatalogEntry } from "@/lib/agentConnectCatalog";
import { FIRST_CONNECT_TASK } from "./ConnectDone";

export function ConnectStatus({ entry, name, approved, elapsed, onCheck, onAgain, onFirstTask, copiedFirst }: {
  entry: ConnectCatalogEntry; name: string; approved: boolean; elapsed: number;
  onCheck: () => void; onAgain: () => void; onFirstTask: () => void; copiedFirst: boolean;
}) {
  const manual = entry.route === "open" || entry.route === "settings";
  const title = approved ? "Access approved" : manual ? `Continue in ${name}` : "Waiting for your agent…";
  const body = approved ? manual ? `Send this first task to ${name}. We’ll confirm the connection when it reads your page.`
    : `Return to ${name} to finish connecting. We’re checking that it can reach your page.`
    : entry.route === "own" ? `Add the settings to ${name} and start it. This page will update when it connects.`
      : manual ? `Add the connection in ${name}, then approve page access in your browser.`
        : `Paste the message into ${name}, then follow its setup prompt. This page will update when it connects.`;
  return <section role="status" className="mt-7 space-y-4 rounded-xl border border-border p-6">
    <div><h2 className="font-semibold">{title}</h2><p className="mt-1 text-sm text-text-secondary">{body}</p></div>
    {approved && manual ? <p className="text-sm">{FIRST_CONNECT_TASK}</p> : null}
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {approved && manual ? <button type="button" className="min-h-11 rounded bg-accent px-3 text-white" onClick={onFirstTask}>Copy first task</button> : null}
      {approved ? <button type="button" className="min-h-11 rounded border border-border px-3" onClick={onCheck}>Check connection</button>
        : manual ? <a className="text-accent" href={entry.url} target="_blank" rel="noopener noreferrer">Open {name} again</a>
          : <button type="button" className="min-h-11 rounded border border-border px-3" onClick={onAgain}>{entry.route === "own" ? "Copy settings" : "Copy again"}</button>}
      <a className="text-accent" href={entry.guide}>{approved ? "Setup help" : entry.route === "own" ? "Connection guide" : "Set up manually"}</a>
    </div>
    {copiedFirst ? <p className="text-sm">Copied — send this to {name}</p> : null}
    {elapsed >= 20_000 ? <p className="text-sm">Nothing happened? <a className="text-accent" href={entry.guide}>Open setup help</a></p> : null}
    {elapsed >= 60_000 ? <p className="text-sm text-text-secondary">Still waiting. Your agent may need you to finish setup.</p> : null}
  </section>;
}
