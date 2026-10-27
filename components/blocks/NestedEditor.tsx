"use client";
import { EditorSurface } from "@/components/BlockEditor";
import type { Block } from "@/lib/types";
import { useStore } from "@/lib/store";
import { useReadOnlyData, useResolvedPages } from "@/lib/readOnlyData";
import { ReadOnlyBlocks } from "@/components/ReadOnlyPage";
export default function NestedEditor({ blocks, onChange, pageId, locked }: { blocks: Block[]; onChange: (next: Block[]) => void; pageId: string; locked?: boolean }) {
  const readOnly = useReadOnlyData(), pages = useResolvedPages(), actorId = useStore((s) => s.syncUserId ?? "local");
  if (readOnly) return <ReadOnlyBlocks pageId={pageId} blocks={blocks} />;
  return <EditorSurface blocks={blocks} onChange={onChange} pageId={pageId} locked={locked} pages={pages} actorId={actorId} nested />;
}
