import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { setupMessage, type ConnectCatalogEntry } from "@/lib/agentConnectCatalog";
import { ConnectNotice } from "./ConnectNotice";

export function ConnectSetup({ entry, serverUrl, copied, copyError, onCopy, onChange, onOpen, children, content }: {
  entry: ConnectCatalogEntry; serverUrl: string; copied: boolean; copyError: boolean;
  onCopy: () => void; onChange: () => void; onOpen?: () => void; children?: ReactNode; content?: ReactNode;
}) {
  const labels = entry.route === "own" ? ["Create its token", "Add the settings", "Start your agent"]
    : entry.route === "message" ? ["Copy the message", `Paste it into ${entry.name}`, "Approve in your browser"]
      : entry.route === "open" ? [`Open ${entry.name}`, "Review the connection", "Approve in your browser"]
        : ["Open its settings", "Add colabora.si", "Approve in your browser"];
  return <>
    <div className="mb-2 flex flex-wrap items-center gap-3.5">
      <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white">{entry.route === "own" ? <Bot size={26} className="text-neutral-700" /> : <img src={entry.logo} width={36} height={36} alt="" className="h-9 w-9 object-contain" />}</span>
      <h1 className="min-w-0 flex-1 text-[28px] font-bold leading-tight">Connect {entry.name}</h1>
      <button type="button" onClick={onChange} className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-bg-secondary">Change agent</button>
    </div>
    <p className="mb-7 text-text-secondary">{entry.helper}</p>
    <ol aria-label="Connection steps" className="grid grid-cols-3 gap-2.5 text-xs text-text-secondary">{labels.map((label, index) => <li key={label} aria-current={index === 0 ? "step" : undefined} className="min-w-0"><div className={`mb-2.5 h-1 rounded ${index === 0 ? "bg-accent" : "bg-border"}`} />{index + 1}. {label}</li>)}</ol>
    {content ?? <section aria-label={entry.route === "message" ? "Setup message" : entry.route === "own" ? "Agent details" : "Connection details"} className="mt-7 overflow-hidden rounded-xl border border-border">
      {entry.route === "own" ? children : <>
        {entry.route === "message" ? <pre className="whitespace-pre-wrap break-words bg-bg-secondary p-5 font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere]">{setupMessage(entry)}</pre>
          : <dl className="space-y-3 bg-bg-secondary p-5 text-sm"><div><dt className="text-xs text-text-secondary">Name</dt><dd>colabora.si</dd></div><div><dt className="text-xs text-text-secondary">Server URL</dt><dd className="break-all font-mono text-[13px]">{serverUrl}</dd></div><div><dt className="text-xs text-text-secondary">Authentication</dt><dd>OAuth</dd></div></dl>}
        <div className="p-3">{entry.route === "message" ? <button data-setup-action type="button" onClick={onCopy} className="min-h-11 w-full rounded-lg bg-accent px-4 font-semibold text-white">Copy setup message</button>
          : <a href={entry.url} onClick={onOpen} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 font-semibold text-white">{entry.action}</a>}</div>
      </>}
    </section>}
    {copied ? <p role="status" className="mt-3 text-sm">Copied — paste into {entry.name}</p> : null}
    {copyError ? <p role="alert" className="mt-3 text-sm">We couldn’t copy the message. Select it below and copy it yourself.</p> : null}
    <p className="mt-4 text-center text-sm text-text-secondary">{entry.route === "own" ? "Can it sign in through a browser? Use the server URL instead." : "You’ll review page access before it connects."}</p>
    <div className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-accent"><a className="hover:underline" href={entry.guide}>Set up manually</a><a className="hover:underline" href="/connect.md">Other agents and setup help</a></div>
    <ConnectNotice />
  </>;
}
