import { useEffect, useState } from "react";
import { LessonCard } from "@/components/agents/panel/LessonCard";
import { decideLesson, lessonScopes, type LessonRow, type LessonScope } from "@/lib/agentLessons";

// Connects a proposed lesson: loads where it can apply and sends the person's decision.
export function LessonProposal({ lesson }: { lesson: LessonRow }) {
  const [scopes, setScopes] = useState<LessonScope[]>([]);
  useEffect(() => {
    if (!lesson.source_task_id) return;
    let live = true;
    void lessonScopes(lesson.source_task_id).then((rows) => { if (live) setScopes(rows); }).catch(() => {});
    return () => { live = false; };
  }, [lesson.source_task_id]);
  return <LessonCard lesson={lesson} scopes={scopes} onDecide={async (decision, edits) => {
    await decideLesson(lesson.id, decision, decision === "accept" ? edits : {});
  }} />;
}
