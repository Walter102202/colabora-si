"use client";

// Agent layer plug. Mounted by the database views as the cell of the
// `agentStatus` and `agentDelegate` property types. Stub for now.
export interface AgentPropertyCellProps {
  pageId: string;
  propertyId: string;
  kind: "agentStatus" | "agentDelegate";
}

export function AgentPropertyCell(props: AgentPropertyCellProps) {
  void props;
  return null;
}
