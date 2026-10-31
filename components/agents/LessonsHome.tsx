import { useEffect, useMemo } from "react";
import { LessonProposal } from "@/components/agents/LessonProposal";
import { HomeCards } from "@/components/agents/panel/HomeCards";
import { proposedLessons, useAgentLessons } from "@/lib/agentLessons";

// Lessons that wait for a person. DecisionsHome mounts it above the task sections.
export function LessonsHome({ workspaceId }: { workspaceId: string }) {
  const lessons = useAgentLessons((s) => s.lessons);
  const subscribe = useAgentLessons((s) => s.subscribe);
  useEffect(() => subscribe(workspaceId), [subscribe, workspaceId]);
  const proposed = useMemo(() => proposedLessons(lessons), [lessons]);
  return <HomeCards title="Lessons to review" items={proposed.map((lesson) => <LessonProposal key={lesson.id} lesson={lesson} />)} />;
}
