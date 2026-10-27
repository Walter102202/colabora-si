"use client";
import { EditorSurface } from "@/components/BlockEditor";
import type { Block } from "@/lib/types";
import { useStore } from "@/lib/store";
export default function NestedEditor({ blocks, onChange, pageId, locked }: { blocks: Block[]; onChange: (next: Block[]) => void; pageId: string; locked?: boolean }) {
  const pages = useStore((s) => s.pages), actorId = useStore((s) => s.syncUserId ?? "local");
  return <EditorSurface blocks={blocks} onChange={onChange} pageId={pageId} locked={locked} pages={pages} actorId={actorId} nested />;
}
