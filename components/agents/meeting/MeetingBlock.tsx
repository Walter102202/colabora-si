import type { Block } from "@/lib/types";

// Recording controls are implemented by the meeting recorder UI task.
export default function MeetingBlock({ block, pageId, readOnly = false }: { block: Block; pageId: string; readOnly?: boolean }) {
  return <div data-meeting-page={pageId} data-readonly={readOnly}>Meeting: {block.meeting?.status ?? "idle"}</div>;
}
