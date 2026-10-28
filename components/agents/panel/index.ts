// Reusable views of the agent layer: data and callbacks in, no router, stores
// or network. Mount them in the workspace (see components/agents/RowPanel.tsx)
// or in an isolated React root such as an MCP App card.
export { RowPanelView, AssignView, TaskView } from "@/components/agents/panel/RowPanelView";
export type { RowPanelViewProps, AssignViewProps, TaskViewProps, AgentOption } from "@/components/agents/panel/RowPanelView";
export { ApprovalCard } from "@/components/agents/panel/ApprovalCard";
export { DecisionCard } from "@/components/agents/panel/DecisionCard";
export { LeadReviewCard } from "@/components/agents/panel/LeadReviewCard";
export type { FindingStatus, ReviewFinding, ReviewVerdict } from "@/components/agents/panel/LeadReviewCard";
export { SubtaskList } from "@/components/agents/panel/SubtaskList";
export type { SubtaskItem } from "@/components/agents/panel/SubtaskList";
export { StatusBadge } from "@/components/agents/panel/StatusBadge";
export { VerificationCard } from "@/components/agents/panel/VerificationCard";
export { ActivityTimeline } from "@/components/agents/panel/ActivityTimeline";
export { FeedbackComposer } from "@/components/agents/panel/FeedbackComposer";
export { taskSubtitle, expiresIn, activityLabel } from "@/lib/agentTaskText";
export type { ActivityRow, ApprovalRow, ArtifactRow, BriefRow, ReviewRow, RunRow, TaskRow } from "@/lib/agentTasks";
export type { ApprovalDecision, MessageSignal } from "@/lib/agentActions";
