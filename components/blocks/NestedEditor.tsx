"use client";
import { EditorSurface } from "@/components/BlockEditor";
import type { Block } from "@/lib/types";
export default function NestedEditor({ blocks, onChange, pageId, locked }: { blocks: Block[]; onChange: (next: Block[]) => void; pageId: string; locked?: boolean }) {
  return <EditorSurface blocks={blocks} onChange={onChange} pageId={pageId} locked={locked} nested />;
}
