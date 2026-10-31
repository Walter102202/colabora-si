import { useEffect, useMemo } from "react";
import { LessonProposal } from "@/components/agents/LessonProposal";
import { proposalsOfTask, useAgentLessons } from "@/lib/agentLessons";

// The proposals born from corrections on this task, next to the correction. RowPanel hands it to TaskView.
export function TaskLessons({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const lessons = useAgentLessons((s) => s.lessons);
  const subscribe = useAgentLessons((s) => s.subscribe);
  useEffect(() => subscribe(workspaceId), [subscribe, workspaceId]);
  const proposals = useMemo(() => proposalsOfTask(lessons, taskId), [lessons, taskId]);
  return <>{proposals.map((lesson) => <LessonProposal key={lesson.id} lesson={lesson} />)}</>;
}
