// What a person settles on a delivery: a short account of the work and one button. Pure.
export function AcceptCard({ summary, deliveredSubtasks, disabled, ciLine, ciBlocks, onAccept }: {
  summary: string;
  ciLine?: string | null;
  ciBlocks?: boolean;
  deliveredSubtasks: number;
  disabled: boolean;
  onAccept: () => void;
}) {
  return (
    <section aria-label="Ready for you" className="space-y-2 rounded-md border border-green-600/40 bg-green-600/5 p-3">
      <h4 className="text-sm font-medium">Ready for you</h4>
      <p className="whitespace-pre-wrap text-sm">{summary}</p>
      {ciLine && <p role="status" className="text-xs text-text-secondary">{ciLine}</p>}
      {deliveredSubtasks > 0 && (
        <p className="text-xs text-text-secondary">
          Accepting also closes {deliveredSubtasks === 1 ? "its delivered subtask" : `its ${deliveredSubtasks} delivered subtasks`}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={disabled || ciBlocks} onClick={onAccept}>
          Accept
        </button>
        <span className="text-xs text-text-tertiary">{ciBlocks ? "Accept opens when CI passes." : "Something to change? Write it below."}</span>
      </div>
    </section>
  );
}
