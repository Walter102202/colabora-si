import type { EnvironmentResource } from "@/lib/agentTasks";

export function EnvironmentCard({ environment }: { environment: EnvironmentResource[] }) {
  if (!environment.length) return null;
  return <section className="space-y-1" aria-label="Task environment">
    <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Environment</h4>
    <ul className="space-y-1 text-xs">
      {environment.map((item) => <li key={`${item.kind}:${item.value}`} className="flex flex-wrap gap-x-2">
        <span className="text-text-secondary">{item.kind}</span>
        <code className="break-all">{item.value}</code>
        <span className="text-text-tertiary">{item.status === "releasing" ? "Waiting for shutdown confirmation" : item.status}</span>
      </li>)}
    </ul>
  </section>;
}
