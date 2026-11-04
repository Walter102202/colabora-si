import { createBlock, createPage, newId } from "@/lib/factories";
import { tramaCoverUrl } from "@/lib/cover";

export function buildMeetingsPage() {
  const id = newId();
  return createPage({ title: "Meetings", icon: "🎙️", cover: tramaCoverUrl("gardener"), blocks: [
    createBlock("callout", { icon: "🎙️", html: "Record a meeting here. Press Start, talk, press Stop. The transcript appears as you go and, when you finish, Trama writes a summary with the decisions and action items." }),
    createBlock("paragraph", { html: "Type your own notes under <strong>Notes</strong> during the meeting: the summary builds on them. Say out loud that you are recording; the audio is transcribed by Meta and never stored." }),
    createBlock("paragraph", { html: "On any other page, type <strong>/meeting</strong> to record in place." }),
    createBlock("meeting", { id, meeting: { id, status: "idle", launcher: true } }),
  ] });
}
