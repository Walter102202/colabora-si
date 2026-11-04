import type { Block } from "@/lib/types";
import { createBlock } from "@/lib/factories";

export function meetingBlockSet(meetingId: string): Block[] {
  return [
    createBlock("meeting", { id: meetingId, meeting: { id: meetingId, status: "idle" } }),
    createBlock("heading2", { html: "Notes", key: `meeting:notes:${meetingId}` }),
    createBlock("paragraph"),
    createBlock("heading2", { html: "Summary", key: `meeting:summary:${meetingId}`, toggleable: true }),
    createBlock("heading2", { html: "Transcript", key: `meeting:transcript:${meetingId}`, toggleable: true, collapsed: true }),
  ];
}
