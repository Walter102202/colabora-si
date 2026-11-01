import { Copy } from "lucide-react";
import type { JobReadyData, JobSentence } from "@/lib/agentJobs";

export interface JobReadyPanelProps {
  data: JobReadyData;
  copiedAgentIds: string[];
  onCopy: (line: JobSentence) => void;
  onOpenPage: () => void;
  error?: string | null;
}

export function JobReadyPanel({ data, copiedAgentIds, onCopy, onOpenPage, error }: JobReadyPanelProps) {
  const waiting = data.lines.some((line) => line.isLead && copiedAgentIds.includes(line.agentId));
  return (
    <section aria-label="Ready when you are" className="min-w-0 bg-bg-secondary px-4 py-3.5 text-sm text-text sm:pl-12">
      <h3 className="text-base font-semibold">Ready when you are</h3>
      <p className="mb-3 mt-0.5 text-text-secondary">{data.sayThis}</p>
      <div className="grid gap-2">
        {data.lines.map((line) => <div key={line.agentId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border border-border bg-bg py-2 pl-3.5 pr-2">
          {line.logo && <img src={line.logo} alt="" width={24} height={24} className="size-6 shrink-0 object-contain" />}
          <span className="basis-21 text-[13px] text-text-secondary">{line.name}</span>
          <q className="min-w-0 flex-[1_1_320px] break-words text-base font-medium">{line.text}</q>
          <button type="button" aria-label={`Copy what to say to ${line.name}`} onClick={() => onCopy(line)} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] font-medium hover:bg-bg-secondary">
            <Copy size={15} aria-hidden="true" />{copiedAgentIds.includes(line.agentId) ? "Copied" : "Copy"}
          </button>
        </div>)}
      </div>
      {waiting ? <p role="status" className="mt-3 flex items-center gap-2.5"><span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />{data.waitingText}</p>
        : <p className="mt-3 text-text-secondary">{data.readyNote} {data.planText} <button type="button" onClick={onOpenPage} className="text-accent hover:underline">Open the page</button></p>}
      {error && <p role="alert" className="mt-2 text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
