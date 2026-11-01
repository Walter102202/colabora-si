import { JOB_STATE_LABEL, type JobAgent, type JobState, type JobWaiting } from "@/lib/agentJobs";

export interface JobsBoardCard {
  id: string;
  title: string;
  lead: JobAgent | null;
  state: JobState;
  progress?: { done: number; total: number };
  waiting: JobWaiting;
}
const laneOf = (state: JobState) => state === "needs_lead" || state === "ready" ? state : ["done", "failed", "cancelled"].includes(state) ? "done" : "working";
const laneClass = { needs_lead: "bg-bg-secondary text-text-secondary", ready: "bg-accent/15 text-accent", working: "bg-accent/15 text-accent", done: "bg-green-500/15 text-green-700 dark:text-green-400" };

export function JobsBoard({ jobs, onOpen }: { jobs: JobsBoardCard[]; onOpen: (id: string) => void }) {
  return <div className="flex items-start gap-2.5 overflow-x-auto pb-5 pt-1">
    {(["needs_lead", "ready", "working", "done"] as const).map((lane) => {
      const cards = jobs.filter((job) => laneOf(job.state) === lane);
      return <section key={lane} aria-label={JOB_STATE_LABEL[lane]} className="min-w-0 flex-[1_0_200px]">
        <header className="flex h-7 items-center gap-2 text-xs text-text-secondary"><span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-medium ${laneClass[lane]}`}>{JOB_STATE_LABEL[lane]}</span>{cards.length}</header>
        {cards.map((job) => <article key={job.id} className={`my-1.5 rounded-lg border border-border p-2.5 text-sm shadow-sm ${job.waiting.label === "You" ? "bg-yellow-500/5" : "bg-bg"}`}>
          <button type="button" aria-label={`Open ${job.title}`} onClick={() => onOpen(job.id)} className="block w-full break-words text-left font-semibold hover:underline">{job.title || "Untitled"}</button>
          <div className="mt-2 flex items-center gap-1.5 text-[13px] text-text-secondary">
            {job.lead?.logo && <img src={job.lead.logo} alt="" width={18} height={18} className="size-[18px] shrink-0 object-contain" />}<span>{job.lead?.name ?? "No Lead yet"}</span>
          </div>
          {job.progress && job.progress.total > 0 && <div className="mt-2.5 flex items-center gap-2 text-[13px] text-text-secondary">
            <div aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-sm bg-border"><div className={`h-full ${lane === "done" ? "bg-green-600 dark:bg-green-400" : "bg-accent"}`} style={{ width: `${Math.min(100, Math.max(0, job.progress.done / job.progress.total * 100))}%` }} /></div>
            <span className="font-medium tabular-nums" aria-label={`${job.progress.done} of ${job.progress.total} subtasks done`}>{job.progress.done}/{job.progress.total}</span>
          </div>}
          {(job.waiting.label === "You" || job.waiting.label === "Lead") && <p className="mt-2 text-xs text-text-secondary">Waiting on <span className={`rounded px-1.5 py-px font-semibold ${job.waiting.label === "You" ? "bg-yellow-500/20 text-yellow-800 dark:text-yellow-300" : "bg-accent/15 text-accent"}`}>{job.waiting.label}{job.waiting.count ? ` ${job.waiting.count}` : ""}</span></p>}
          {(job.state === "failed" || job.state === "cancelled") && <p className="mt-2 text-xs text-text-secondary">{JOB_STATE_LABEL[job.state]}</p>}
        </article>)}
        {!cards.length && <p className="my-1.5 text-[13px] text-text-secondary">No jobs here</p>}
      </section>;
    })}
  </div>;
}
