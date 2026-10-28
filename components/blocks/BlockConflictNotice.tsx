import { useState } from "react";
import { useBlockConflicts } from "@/lib/syncConflicts";
import { useStore } from "@/lib/store";
import { stripHtml } from "@/lib/utils";
import { useAuthStore } from "@/lib/auth";
import type { Block } from "@/lib/types";
import { usePresence } from "@/lib/presence";

export default function BlockConflictNotice({ pageId, blockId, deleted = false }: { pageId: string; blockId: string; deleted?: boolean }) {
  const conflict = useBlockConflicts((s) => s.byPage[pageId]?.find((c) => c.id === blockId));
  const members = useStore((s) => s.members), agents = useStore((s) => s.agents), user = useAuthStore((s) => s.user);
  const others = usePresence((s) => s.others);
  const [open, setOpen] = useState(false);
  if (!conflict) return null;
  const actor = [...(members ?? []), ...(agents ?? [])].find((a) => a.id === conflict.by?.id)?.name ?? others.find((a) => a.userId === conflict.by?.id)?.name ?? (conflict.by?.id === user?.id ? "You" : conflict.by?.by === "agent" ? "An agent" : "Someone");
  const value = conflict.theirs;
  const preview = value && typeof value === "object" && "html" in value ? stripHtml(String(value.html)) : typeof value === "string" ? value : JSON.stringify(value);
  const resolve = (choice: "mine" | "theirs" | "both") => useBlockConflicts.getState().resolve(pageId, blockId, choice);
  return <div className="block-conflict" contentEditable={false}><button className="text-left" onClick={() => setOpen(!open)} aria-expanded={open}>{actor} edited this block at the same time · <span className="underline">See their version</span></button>{open && <div className="block-conflict-preview"><p className="mb-3 whitespace-pre-wrap text-text-primary">{preview}</p><div className="flex flex-wrap gap-2"><button className="action-button" onClick={() => resolve("mine")}>Keep mine</button><button className="action-button" onClick={() => resolve("theirs")}>{deleted ? "Keep theirs" : "Use theirs"}</button>{!deleted && <button className="action-button" onClick={() => resolve("both")}>Keep both</button>}</div></div>}</div>;
}
function contains(blocks: Block[], id: string): boolean { return blocks.some((b) => b.id === id || b.columns?.some((c) => contains(c.blocks, id))); }
export function DeletedBlockConflicts({ pageId, blocks }: { pageId: string; blocks: Block[] }) {
  const conflicts = useBlockConflicts((s) => s.byPage[pageId]);
  return <>{conflicts?.filter((c) => !contains(blocks, c.id)).map((conflict) => <BlockConflictNotice key={conflict.id} pageId={pageId} blockId={conflict.id} deleted />)}</>;
}
