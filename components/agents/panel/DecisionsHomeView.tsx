import type { DecisionsHomeData, HomeSection } from "@/lib/agentHome";

export interface DecisionsHomeViewProps {
  home: DecisionsHomeData; loading?: boolean;
  // Set when the tasks failed to load: the sections would claim that nothing waits.
  error?: string | null; onRetry?: () => void;
}

const SECTIONS: { key: HomeSection; title: string; empty: string }[] = [
  { key: "waiting", title: "Waiting for your decision", empty: "Nothing waits for your decision." },
  { key: "working", title: "Agents working", empty: "No agent is working for you right now." },
  { key: "review", title: "Ready for your review", empty: "Nothing to review." },
  { key: "done", title: "Done today", empty: "Nothing closed today yet." },
];

export function DecisionsHomeView({ home, loading = false, error = null, onRetry }: DecisionsHomeViewProps) {
  if (error) {
    return (
      <section aria-label="Decisions" className="mb-12 space-y-2 text-sm">
        <p role="alert" className="text-text-secondary">Could not load decisions: {error}</p>
        {onRetry && <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={onRetry}>Try again</button>}
      </section>
    );
  }
  if (loading) return <section aria-label="Decisions" aria-busy="true" className="mb-12 text-sm text-text-tertiary">Loading decisions…</section>;
  return (
    <section aria-label="Decisions" className="mb-12 grid gap-6 sm:grid-cols-2">
      {SECTIONS.map(({ key, title, empty }) => (
        <div key={key}>
          <h2 className="mb-3 text-xs text-text-tertiary">{title} ({home[key].length})</h2>
          {home[key].length ? <ul className="space-y-1">
            {home[key].map((item) => (
              <li key={item.key}>
                <a href={item.href} data-stale={item.stale || undefined} className="block rounded px-2 py-2 hover:bg-bg-secondary">
                  <div className="text-sm font-medium">{item.title}</div>
                  <div className="text-xs text-text-tertiary">
                    {item.detail}{item.agentName && ` · ${item.agentName}`}{item.nonBlocking && " · The agent keeps working"}
                  </div>
                </a>
              </li>
            ))}
          </ul> : <p className="text-sm text-text-tertiary">{empty}</p>}
        </div>
      ))}
    </section>
  );
}
