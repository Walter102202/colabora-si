import { useAuthStore } from "@/lib/auth";
import { useEffect, useMemo } from "react";
import { LessonProposal } from "@/components/agents/LessonProposal";
import { proposalsOfTask, useAgentLessons } from "@/lib/agentLessons";

// The proposals born from corrections on this task, next to the correction. RowPanel hands it to TaskView.
export function TaskLessons({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const user = useAuthStore((s) => s.user);
  const lessons = useAgentLessons((s) => s.lessons);
  const subscribe = useAgentLessons((s) => s.subscribe);
  useEffect(() => user ? subscribe(workspaceId) : undefined, [subscribe, workspaceId, user]);
  const proposals = useMemo(() => proposalsOfTask(lessons, taskId).filter((l) => l.workspace_id === workspaceId), [lessons, taskId, workspaceId]);
  if (!user) return null;
  return <>{proposals.map((lesson) => <LessonProposal key={lesson.id} lesson={lesson} />)}</>;
}
