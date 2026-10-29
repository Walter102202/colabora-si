import { useEffect, useId, useState } from "react";
import { getAutonomyPolicy, setWorkspaceAutonomy } from "@/lib/agentActions";
import { AUTONOMY_HELP, AUTONOMY_LABEL, AUTONOMY_LEVELS, type AutonomyLevel, type AutonomyPolicy } from "@/lib/agentAutonomy";
import { useQueuedChoice } from "@/components/agents/panel/useQueuedChoice";

export function AutonomySettingsView({ policy, busy, error, onChange }: {
  policy: AutonomyPolicy | null;
  busy: boolean;
  error: string | null;
  onChange: (level: AutonomyLevel) => void;
}) {
  const id = useId();
  if (!policy) return error
    ? <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>
    : <div className="h-10 animate-pulse rounded-md bg-bg-secondary" aria-busy="true" />;
  return (
    <fieldset disabled={!policy.can_edit} aria-busy={busy} className="space-y-2 rounded-md border border-border p-3 text-sm">
      <legend className="px-1 font-medium">Autonomy</legend>
      <p className="text-xs text-text-secondary">What agents may do without asking. Questions always reach you, payments always ask, and every automatic approval is recorded. A workspace at Ask first also stops tasks set higher; a preapproval in a task&apos;s brief still counts.</p>
      {AUTONOMY_LEVELS.map((level) => (
        <div key={level} className="flex items-start gap-2">
          <input id={`${id}-${level}`} name={id} type="radio" value={level} checked={policy.level === level} onChange={() => onChange(level)} className="mt-1" />
          <label htmlFor={`${id}-${level}`}>
            <strong>{AUTONOMY_LABEL[level]}</strong>{" "}
            <span className="text-xs text-text-secondary">{AUTONOMY_HELP[level]}</span>
          </label>
        </div>
      ))}
      {!policy.can_edit && <p className="text-xs text-text-secondary">Only a workspace owner can change this, from the app.</p>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </fieldset>
  );
}

export function AutonomySettings({ workspaceId }: { workspaceId: string | null }) {
  const [policy, setPolicy] = useState<AutonomyPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // An arrow key in the group changes the level: the radios stay enabled while it saves and the latest choice wins.
  const choice = useQueuedChoice<AutonomyLevel>();
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void getAutonomyPolicy(workspaceId).then(
      (value) => { if (alive) { setPolicy(value); setLoadError(null); } },
      (e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { alive = false; };
  }, [workspaceId]);

  if (!workspaceId) return null;
  const save = async (level: AutonomyLevel) => {
    const next = await setWorkspaceAutonomy(workspaceId, level);
    setPolicy((current) => current ? { ...current, level: next.level } : current);
  };
  const shown = policy && choice.pending ? { ...policy, level: choice.pending.value } : policy;
  return <AutonomySettingsView policy={shown} busy={choice.busy} error={choice.error ?? loadError} onChange={(level) => { void choice.choose(level, save); }} />;
}
