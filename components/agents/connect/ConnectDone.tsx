import { CheckCircle2 } from "lucide-react";
import { Link } from "react-router";
import { HOME_URL, pageUrl, settingsUrl } from "@/lib/routes";

export const FIRST_CONNECT_TASK = "Read “Getting started” in colabora.si, then create a page inside it called “Our first plan”. Add sections for Goal, Next steps, and Open questions, with one short question in each section to help me get started. Then send me the page link.";
export function ConnectDone({ name, pageId, copied, onCopy }: { name: string; pageId: string; copied: boolean; onCopy: () => void }) {
  return <div className="mt-7 space-y-5">
    <div role="status" className="flex gap-3 rounded-xl border border-border p-6"><CheckCircle2 className="shrink-0 text-accent" /><div><h2 className="font-semibold">{name} is connected</h2><p className="text-sm text-text-secondary">It can work with you in Getting started.</p></div></div>
    <section className="space-y-3 rounded-xl border border-border bg-bg-secondary p-5"><h2 className="font-semibold">Try this first</h2><p className="text-sm leading-relaxed">{FIRST_CONNECT_TASK}</p><button type="button" onClick={onCopy} className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-white">Copy first task</button>
      {copied ? <p role="status" className="text-sm">Copied — send this to {name}</p> : null}
      <p className="text-sm text-text-secondary">Your agent will create a page here. Keep using it in {name}.</p>
    </section>
    <div className="flex flex-wrap gap-4 text-sm text-accent"><Link to={pageUrl(pageId)}>Open Getting started</Link><Link to={settingsUrl("agents")}>Manage access</Link><Link to={HOME_URL}>Go to workspace</Link></div>
  </div>;
}
