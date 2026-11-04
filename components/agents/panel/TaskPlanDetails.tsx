import type { BriefRow, TaskRow } from "@/lib/agentTasks";
import { pageUrl } from "@/lib/routes";
import { safeHref } from "@/lib/utils";

export function TaskPlanDetails({ task, brief, onOpenPage }: {
  task: TaskRow;
  brief: BriefRow | null;
  onOpenPage: (pageId: string) => void;
}) {
  return <div className="space-y-4">
    <section className="space-y-2" aria-label="Task brief">
      <h4 className="text-sm font-medium">Brief v{brief?.version ?? task.brief_version}</h4>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{brief?.objective || task.title || "Loading brief…"}</p>
      {brief?.next_step && <div className="rounded-md bg-bg-secondary p-3">
        <h5 className="text-xs font-medium text-text-secondary">Next step in this brief</h5>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{brief.next_step}</p>
      </div>}
      {task.brief_stale && <p className="text-xs text-yellow-700 dark:text-yellow-400">This brief changed after the current run started.</p>}
    </section>
    {brief && <>
      <section className="space-y-2" aria-label="Acceptance criteria">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Done when</h4>
        {brief.done_when.length ? <ol className="space-y-2">
          {brief.done_when.map((criterion) => <li key={criterion.id} className="rounded-md border border-border px-3 py-2">
            <p className="whitespace-pre-wrap break-words text-sm">{criterion.text}</p>
            <p className="mt-1 text-xs text-text-tertiary">{criterion.id} · checked by {criterion.check === "ci" ? "CI" : criterion.check === "lead" ? "the Lead" : criterion.check === "human" ? "a person" : "a deterministic check"}</p>
            {criterion.command && <code className="mt-1 block whitespace-pre-wrap break-all text-xs text-text-secondary">{criterion.command}</code>}
          </li>)}
        </ol> : <p className="text-xs text-text-tertiary">No acceptance criteria were written.</p>}
        <p className="text-xs text-text-tertiary">These are the requirements. Their verification is in Work.</p>
      </section>
      {brief.constraints && <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Constraints</h4>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{brief.constraints}</p>
      </section>}
      {brief.sources?.length > 0 && <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Sources</h4>
        <ul className="space-y-2 text-sm">{brief.sources.map((source, index) => {
          const href = source.kind === "url" ? safeHref(source.ref) : undefined;
          return <li key={`${source.kind}:${source.ref}:${index}`} className="break-words">
            {source.kind === "page" ? <a href={pageUrl(source.ref)} className="text-accent underline" onClick={(event) => { event.preventDefault(); onOpenPage(source.ref); }}>{source.ref}</a>
              : href ? <a href={href} className="text-accent underline" target="_blank" rel="noopener noreferrer">{source.ref}</a>
                : <span>{source.ref}</span>}
            <span className="ml-2 text-xs text-text-tertiary">{source.kind} · {source.trust}</span>
          </li>;
        })}</ul>
      </section>}
      {brief.open_questions?.length > 0 && <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Questions in the brief</h4>
        <ul className="list-disc space-y-1 pl-4 text-sm">{brief.open_questions.map((question, index) => <li key={index} className="whitespace-pre-wrap break-words">{question}</li>)}</ul>
      </section>}
      {brief.decisions?.length > 0 && <section className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Recorded decisions</h4>
        <ol className="space-y-2">{brief.decisions.map((decision, index) => <li key={`${decision.at}:${index}`} className="rounded-md border border-border p-2">
          <p className="whitespace-pre-wrap break-words text-sm">{decision.text}</p>
          <p className="mt-1 break-words text-xs text-text-tertiary">{decision.by}{decision.at ? ` · ${decision.at}` : ""}</p>
        </li>)}</ol>
      </section>}
      {brief.policies && Object.keys(brief.policies).length > 0 && <details className="rounded-md border border-border p-3 text-xs">
        <summary className="cursor-pointer font-medium">Policies recorded in this brief</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(brief.policies, null, 2)}</pre>
      </details>}
    </>}
  </div>;
}
