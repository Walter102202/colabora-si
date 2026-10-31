import { useAuthStore } from "@/lib/auth";
import { useEffect, useMemo } from "react";
import { LessonProposal } from "@/components/agents/LessonProposal";
import { HomeCards } from "@/components/agents/panel/HomeCards";
import { proposedLessons, useAgentLessons } from "@/lib/agentLessons";

// Lessons that wait for a person. DecisionsHome mounts it above the task sections.
export function LessonsHome({ workspaceId }: { workspaceId: string }) {
  const user = useAuthStore((s) => s.user);
  const lessons = useAgentLessons((s) => s.lessons);
  const subscribe = useAgentLessons((s) => s.subscribe);
  useEffect(() => user ? subscribe(workspaceId) : undefined, [subscribe, workspaceId, user]);
  const proposed = useMemo(() => proposedLessons(lessons).filter((l) => l.workspace_id === workspaceId), [lessons, workspaceId]);
  if (!user) return null;
  return <HomeCards title="Lessons to review" items={proposed.map((lesson) => <LessonProposal key={lesson.id} lesson={lesson} />)} />;
}
