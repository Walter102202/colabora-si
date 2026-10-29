// Autonomy levels of the agent layer: what agents may do without asking a person. The server decides (migration 0020); this module only names the levels and explains them.
export type AutonomyLevel = "ask" | "balanced" | "autonomous";
export const AUTONOMY_LEVELS: AutonomyLevel[] = ["ask", "balanced", "autonomous"];
export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = { ask: "Ask first", balanced: "Balanced", autonomous: "Autonomous" };
export const AUTONOMY_HELP: Record<AutonomyLevel, string> = {
  ask: "Agents ask before every action outside the workspace, unless the task's brief preapproves it.",
  balanced: "Agents publish pages on their own and ask before email, web requests and payments.",
  autonomous: "Agents publish pages and send email on their own. Web requests ask unless the brief preapproves them; payments always ask.",
};
export interface TaskAutonomy {
  level: AutonomyLevel;
  requested: AutonomyLevel | null;
  source: "workspace" | "task" | "parent";
  workspace_level: AutonomyLevel;
  auto_approved: string[];
  require_approval: string[];
  // Whether this caller may set the task's level (a workspace owner, from the app). Without it the select
  // stays enabled and the server decides.
  can_edit?: boolean;
}
export interface AutonomyPolicy {
  level: AutonomyLevel;
  updated_at: string | null;
  updated_by: string | null;
  can_edit: boolean;
  presets: Record<AutonomyLevel, string[]>;
}
// One line for the panel and the card: the level, where it comes from and what runs without asking.
export function autonomyLine(a: TaskAutonomy | null | undefined): string | null {
  if (!a) return null;
  // The server says "workspace" both without a level of its own and when the workspace holds a higher one down.
  const source = a.source === "workspace" && a.requested ? "limited by the workspace"
    : { workspace: "workspace default", task: "set on this task", parent: "limited by the parent task" }[a.source];
  const actions = a.auto_approved.length ? "runs on its own: " + a.auto_approved.join(", ") : "asks before every outside action";
  return "Autonomy: " + AUTONOMY_LABEL[a.level] + " (" + source + "); " + actions + ".";
}
