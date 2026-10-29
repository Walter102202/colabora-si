import { useEffect, useId, useState } from "react";
import { getAutonomyPolicy, setWorkspaceAutonomy } from "@/lib/agentActions";
import { AUTONOMY_HELP, AUTONOMY_LABEL, AUTONOMY_LEVELS, type AutonomyLevel, type AutonomyPolicy } from "@/lib/agentAutonomy";

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
    <fieldset disabled={busy || !policy.can_edit} className="space-y-2 rounded-md border border-border p-3 text-sm">
      <legend className="px-1 font-medium">Autonomy</legend>
      <p className="text-xs text-text-secondary">What agents may do without asking. Questions always reach you, payments always ask, and every automatic approval is recorded. A workspace at Ask first also stops tasks set higher.</p>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void getAutonomyPolicy(workspaceId).then(
      (value) => { if (alive) { setPolicy(value); setError(null); } },
      (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { alive = false; };
  }, [workspaceId]);

  if (!workspaceId) return null;
  const change = async (level: AutonomyLevel) => {
    setBusy(true);
    setError(null);
    try {
      const next = await setWorkspaceAutonomy(workspaceId, level);
      setPolicy((current) => current ? { ...current, level: next.level } : current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return <AutonomySettingsView policy={policy} busy={busy} error={error} onChange={(level) => { void change(level); }} />;
}
