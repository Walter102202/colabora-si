import { useId, useState } from "react";
import type { LessonDecision, LessonRow, LessonScope } from "@/lib/agentLessons";

const SOURCE: Record<LessonRow["source_kind"], string> = {
  review: "What the review said", feedback: "What the person said", rejection: "Why it was rejected", person: "Written by a person",
};

const sameScope = (lesson: LessonRow, option: LessonScope) => option.scope === lesson.scope
  && (option.scope !== "page" || option.page_id === lesson.scope_page_id);

// A proposed lesson. The person reads what was really corrected, edits the text, narrows who it reaches and decides.
export function LessonCard({ lesson, scopes, onDecide }: {
  lesson: LessonRow;
  scopes: LessonScope[];
  onDecide: (decision: LessonDecision, edits: { text: string; example: string; scope?: LessonScope }) => Promise<void>;
}) {
  const id = useId();
  const [text, setText] = useState(lesson.body);
  const [example, setExample] = useState(lesson.example);
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = choice ?? Math.max(0, scopes.findIndex((s) => sameScope(lesson, s)));

  const decide = async (decision: LessonDecision) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, { text, example, scope: scopes[selected] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
      <p className="font-medium">A lesson from this correction</p>
      {lesson.source_text && <p className="text-xs text-text-secondary">{SOURCE[lesson.source_kind]}: {lesson.source_text}</p>}
      <div className="space-y-1">
        <label htmlFor={`${id}-text`} className="text-xs text-text-secondary">Lesson</label>
        <textarea id={`${id}-text`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" rows={2} maxLength={600} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-example`} className="text-xs text-text-secondary">Example</label>
        <input id={`${id}-example`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" maxLength={600} value={example} disabled={busy} onChange={(e) => setExample(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-scope`} className="text-xs text-text-secondary">Applies to</label>
        <select id={`${id}-scope`} className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" value={selected} disabled={busy || scopes.length === 0} onChange={(e) => setChoice(Number(e.target.value))}>
          {scopes.map((s, i) => <option key={`${s.scope}:${s.page_id ?? ""}`} value={i}>{s.label}</option>)}
        </select>
      </div>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy || !text.trim()} onClick={() => void decide("accept")}>Accept</button>
        <button type="button" className="rounded border border-border px-3 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" disabled={busy} onClick={() => void decide("dismiss")}>Dismiss</button>
      </div>
    </div>
  );
}
