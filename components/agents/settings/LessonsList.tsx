import { useEffect, useMemo, useState } from "react";
import { acceptedLessons, lessonStats, retireLesson, reviseLesson, useAgentLessons, type LessonRow, type LessonStat } from "@/lib/agentLessons";

const firstPass = (part: { tasks: number; first_pass: number }) => (part.tasks ? `${part.first_pass} of ${part.tasks}` : "none yet");

function LessonItem({ lesson, stat }: { lesson: LessonRow; stat?: LessonStat }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.body);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <li className="space-y-1 rounded border border-border p-2 text-sm">
      {editing
        ? <textarea aria-label="Lesson" className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" rows={2} maxLength={600} value={text} onChange={(e) => setText(e.target.value)} />
        : <p>{lesson.body}</p>}
      {stat && <p className="text-xs text-text-tertiary">
        Delivered {stat.delivered} · Cited {stat.cited} · Corrected after {stat.corrected_after} · Right the first time: {firstPass(stat.before)} before, {firstPass(stat.after)} with it
      </p>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        {editing
          ? <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary disabled:opacity-50" disabled={!text.trim()} onClick={() => void act(() => reviseLesson(lesson.id, text, lesson.example))}>Save</button>
          : <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={() => setEditing(true)}>Edit</button>}
        <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-secondary" onClick={() => void act(() => retireLesson(lesson.id))}>Retire</button>
      </div>
    </li>
  );
}

// The lessons that reach agents today and what each one did. Settings → Agents mounts it.
export function LessonsList({ workspaceId }: { workspaceId: string }) {
  const lessons = useAgentLessons((s) => s.lessons);
  const subscribe = useAgentLessons((s) => s.subscribe);
  const [stats, setStats] = useState<LessonStat[]>([]);
  useEffect(() => subscribe(workspaceId), [subscribe, workspaceId]);
  useEffect(() => {
    let live = true;
    void lessonStats(workspaceId).then((rows) => { if (live) setStats(rows); }).catch(() => {});
    return () => { live = false; };
  }, [workspaceId, lessons]);
  const accepted = useMemo(() => acceptedLessons(lessons), [lessons]);
  if (!accepted.length) return null;
  return (
    <section aria-label="Lessons" className="space-y-2">
      <h3 className="text-sm font-semibold">Lessons agents receive ({accepted.length})</h3>
      <ul className="space-y-2">{accepted.map((l) => <LessonItem key={l.id} lesson={l} stat={stats.find((s) => s.lesson_id === l.id)} />)}</ul>
    </section>
  );
}
